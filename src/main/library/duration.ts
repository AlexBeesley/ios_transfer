import fs from 'node:fs';
import path from 'node:path';
import type { AfcClient, AfcFileHandle } from '../device/afc';
import { AfcError } from '../device/afc';
import type { AfcPool } from '../device/session';
import { dcimPath } from './scanner';

/**
 * Reads playback duration out of QuickTime / MP4 containers.
 *
 * There is no duration in the filesystem metadata, so it has to come from the
 * movie header. Rather than pull the file down, the top-level atom chain is
 * walked with seeks: iPhone recordings lay out `ftyp`, then a huge `mdat`, then
 * `moov` at the end, so the whole read is three small requests that skip over
 * the media data entirely.
 */

/** Guards against a corrupt header sending us on a huge read. */
const MAX_MOOV_BYTES = 8 * 1024 * 1024;
const MAX_ATOM_WALK = 64;

interface Box {
  type: string;
  size: number;
  headerLength: number;
}

function readBoxHeader(buffer: Buffer, at: number): Box | null {
  if (at + 8 > buffer.length) return null;
  let size = buffer.readUInt32BE(at);
  const type = buffer.toString('latin1', at + 4, at + 8);
  let headerLength = 8;

  if (size === 1) {
    if (at + 16 > buffer.length) return null;
    size = Number(buffer.readBigUInt64BE(at + 8));
    headerLength = 16;
  }
  return { type, size, headerLength };
}

/** Pulls timescale and duration out of an `mvhd`, which may be v0 or v1. */
function parseMovieHeader(payload: Buffer): number | null {
  if (payload.length < 20) return null;
  const version = payload.readUInt8(0);

  if (version === 1) {
    if (payload.length < 32) return null;
    const timescale = payload.readUInt32BE(20);
    const duration = Number(payload.readBigUInt64BE(24));
    return timescale > 0 ? duration / timescale : null;
  }

  const timescale = payload.readUInt32BE(12);
  const duration = payload.readUInt32BE(16);
  if (timescale <= 0) return null;
  // 0xffffffff means "unknown" in v0 headers.
  if (duration === 0xffffffff) return null;
  return duration / timescale;
}

/**
 * Pulls display dimensions from a track header.
 *
 * tkhd stores width/height as 16.16 fixed point after a fixed run of fields;
 * the offset differs between version 0 and 1 because the timestamps widen.
 */
function parseTrackHeader(payload: Buffer): { width: number; height: number } | null {
  if (payload.length < 84) return null;
  const version = payload.readUInt8(0);
  const at = version === 1 ? 88 : 76;
  if (payload.length < at + 8) return null;
  const width = payload.readUInt32BE(at) / 65536;
  const height = payload.readUInt32BE(at + 4) / 65536;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/** Walks moov > trak > tkhd for the largest visual track. */
function findDimensions(moov: Buffer): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  let offset = 0;

  while (offset + 8 <= moov.length) {
    const box = readBoxHeader(moov, offset);
    if (!box) break;
    const size = box.size === 0 ? moov.length - offset : box.size;
    if (size < box.headerLength) break;

    if (box.type === 'trak') {
      const trak = moov.subarray(offset + box.headerLength, offset + size);
      let inner = 0;
      while (inner + 8 <= trak.length) {
        const child = readBoxHeader(trak, inner);
        if (!child) break;
        const childSize = child.size === 0 ? trak.length - inner : child.size;
        if (childSize < child.headerLength) break;
        if (child.type === 'tkhd') {
          const dims = parseTrackHeader(
            trak.subarray(inner + child.headerLength, inner + childSize),
          );
          if (dims && (!best || dims.width * dims.height > best.width * best.height)) best = dims;
        }
        inner += childSize;
      }
    }
    offset += size;
  }
  return best;
}

function findMovieHeader(moov: Buffer): number | null {
  let offset = 0;
  while (offset + 8 <= moov.length) {
    const box = readBoxHeader(moov, offset);
    if (!box) return null;
    const size = box.size === 0 ? moov.length - offset : box.size;
    if (size < box.headerLength) return null;

    if (box.type === 'mvhd') {
      return parseMovieHeader(moov.subarray(offset + box.headerLength, offset + size));
    }
    offset += size;
  }
  return null;
}

export interface VideoInfo {
  seconds: number | null;
  width: number | null;
  height: number | null;
}

async function readVideoInfo(file: AfcFileHandle, fileSize: number): Promise<VideoInfo> {
  let offset = 0;

  for (let step = 0; step < MAX_ATOM_WALK && offset < fileSize; step++) {
    const header = await file.readAt(offset, 16);
    const box = readBoxHeader(header, 0);
    if (!box) return { seconds: null, width: null, height: null };

    const size = box.size === 0 ? fileSize - offset : box.size;
    if (size < box.headerLength) return { seconds: null, width: null, height: null };

    if (box.type === 'moov') {
      const length = Math.min(size - box.headerLength, MAX_MOOV_BYTES);
      const moov = await file.readAt(offset + box.headerLength, length);
      const dims = findDimensions(moov);
      return {
        seconds: findMovieHeader(moov),
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      };
    }
    offset += size;
  }
  return { seconds: null, width: null, height: null };
}

/** Cached, pooled duration lookups. `null` records a file we could not read. */
export class DurationService {
  private readonly known = new Map<string, VideoInfo>();
  private readonly inFlight = new Map<string, Promise<VideoInfo>>();
  private readonly cacheFile: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(
    private readonly pool: AfcPool,
    cacheDir: string,
  ) {
    this.cacheFile = path.join(cacheDir, 'durations.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8')) as Record<
        string,
        VideoInfo | number
      >;
      for (const [id, value] of Object.entries(raw)) {
        // Older caches stored a bare number.
        this.known.set(
          id,
          typeof value === 'number'
            ? { seconds: value < 0 ? null : value, width: null, height: null }
            : value,
        );
      }
    } catch {
      /* first run */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const payload: Record<string, VideoInfo> = {};
      for (const [id, value] of this.known) payload[id] = value;
      void fs.promises
        .mkdir(path.dirname(this.cacheFile), { recursive: true })
        .then(() => fs.promises.writeFile(this.cacheFile, JSON.stringify(payload)))
        .catch(() => undefined);
    }, 2000);
  }

  private async fetch(assetId: string, sizeHint: number): Promise<VideoInfo> {
    return this.pool.run(async (afc: AfcClient) => {
      const remote = dcimPath(assetId);
      let size = sizeHint;
      if (!size) {
        try {
          size = (await afc.stat(remote)).size;
        } catch {
          return { seconds: null, width: null, height: null };
        }
      }
      try {
        return await afc.withFile(remote, (file) => readVideoInfo(file, size));
      } catch (err) {
        if (err instanceof AfcError) return { seconds: null, width: null, height: null };
        throw err;
      }
    });
  }

  /** Resolves durations in seconds, fetching only the ones not already known. */
  async get(
    requests: Array<{ id: string; size: number }>,
  ): Promise<Record<string, VideoInfo>> {
    await this.load();

    const result: Record<string, VideoInfo> = {};
    const pending: Array<{ id: string; size: number }> = [];

    for (const request of requests) {
      const cached = this.known.get(request.id);
      if (cached) {
        result[request.id] = cached;
      } else {
        pending.push(request);
      }
    }
    if (pending.length === 0) return result;

    await Promise.all(
      pending.map(async ({ id, size }) => {
        let promise = this.inFlight.get(id);
        if (!promise) {
          promise = this.fetch(id, size).catch(
            () => ({ seconds: null, width: null, height: null }) as VideoInfo,
          );
          this.inFlight.set(id, promise);
        }
        try {
          const info = await promise;
          this.known.set(id, info);
          result[id] = info;
        } finally {
          this.inFlight.delete(id);
        }
      }),
    );

    this.scheduleSave();
    return result;
  }
}
