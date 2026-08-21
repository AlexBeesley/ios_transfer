import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AfcError, type AfcClient } from '../device/afc';
import type { AfcPool } from '../device/session';

/**
 * Serves grid thumbnails.
 *
 * iOS already keeps a 360x480-ish JPEG next to every still, so the fast path is
 * a straight file read — no decoding, and no touching multi-megabyte HEIC
 * originals. Those land at:
 *
 *   /PhotoData/Thumbnails/V2/DCIM/<folder>/<file>/5005.JPG
 *
 * Videos have no entry there; their key frames live under a parallel
 * VideoKeyFrames tree, so video paths are probed and the winning layout is
 * remembered.
 *
 * Requests are served newest-first: when someone flings the grid, the tiles now
 * on screen matter and the ones scrolled past do not.
 */

const V2_ROOT = '/PhotoData/Thumbnails/V2/DCIM';
const KEYFRAME_ROOT = '/PhotoData/Thumbnails/VideoKeyFrames/DCIM';
const PREFERRED_VARIANT = '5005.JPG';

const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;

interface PendingRequest {
  assetId: string;
  isVideo: boolean;
  sequence: number;
  resolve: (value: Buffer | null) => void;
  reject: (err: unknown) => void;
}

export class ThumbnailService {
  private readonly memory = new Map<string, Buffer>();
  private memoryBytes = 0;

  private readonly queue: PendingRequest[] = [];
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();
  private readonly missing = new Set<string>();
  private sequence = 0;
  private workers = 0;

  /** Remembered layout for video key frames, learned on first success. */
  private videoLayout: 'v2' | 'keyframe-dir' | 'keyframe-file' | null = null;

  constructor(
    private readonly pool: AfcPool,
    private readonly cacheDir: string,
    private readonly maxWorkers = 8,
  ) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private diskPath(assetId: string): string {
    const hash = crypto.createHash('sha1').update(assetId).digest('hex');
    return path.join(this.cacheDir, hash.slice(0, 2), hash.slice(2) + '.jpg');
  }

  private remember(assetId: string, data: Buffer): void {
    this.memory.set(assetId, data);
    this.memoryBytes += data.length;
    // Map iteration is insertion-ordered, so the oldest entry is the first key.
    while (this.memoryBytes > MEMORY_BUDGET_BYTES) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      const evicted = this.memory.get(oldest.value);
      this.memory.delete(oldest.value);
      this.memoryBytes -= evicted?.length ?? 0;
    }
  }

  /** Candidate device paths for an asset's thumbnail, best guess first. */
  private candidates(assetId: string, isVideo: boolean): string[] {
    if (!isVideo) return [V2_ROOT + '/' + assetId + '/' + PREFERRED_VARIANT];

    const ordered: Array<'v2' | 'keyframe-dir' | 'keyframe-file'> =
      this.videoLayout === 'keyframe-dir'
        ? ['keyframe-dir', 'keyframe-file', 'v2']
        : this.videoLayout === 'keyframe-file'
          ? ['keyframe-file', 'keyframe-dir', 'v2']
          : this.videoLayout === 'v2'
            ? ['v2', 'keyframe-dir', 'keyframe-file']
            : ['keyframe-dir', 'keyframe-file', 'v2'];

    return ordered.map((layout) =>
      layout === 'v2'
        ? V2_ROOT + '/' + assetId + '/' + PREFERRED_VARIANT
        : layout === 'keyframe-dir'
          ? KEYFRAME_ROOT + '/' + assetId + '/' + PREFERRED_VARIANT
          : KEYFRAME_ROOT + '/' + assetId,
    );
  }

  private noteLayout(candidatePath: string): void {
    if (candidatePath.startsWith(V2_ROOT)) this.videoLayout = 'v2';
    else if (candidatePath.endsWith(PREFERRED_VARIANT)) this.videoLayout = 'keyframe-dir';
    else this.videoLayout = 'keyframe-file';
  }

  /**
   * Falls back to whatever variant the device does have.
   *
   * Only reached when the preferred size is absent, so the extra directory
   * listing stays off the hot path.
   */
  private async anyVariant(afc: AfcClient, dir: string): Promise<Buffer | null> {
    try {
      const variants = (await afc.readDirectory(dir)).filter((v) => /\.(jpg|jpeg|png)$/i.test(v));
      if (variants.length === 0) return null;
      // Higher numeric prefixes are larger renditions.
      variants.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
      return await afc.readFile(dir + '/' + variants[0], 512 * 1024);
    } catch {
      return null;
    }
  }

  private async fetchFromDevice(request: PendingRequest, afc: AfcClient): Promise<Buffer | null> {
    const candidates = this.candidates(request.assetId, request.isVideo);

    for (const candidate of candidates) {
      try {
        const data = await afc.readFile(candidate, 512 * 1024);
        if (data.length > 0) {
          if (request.isVideo) this.noteLayout(candidate);
          return data;
        }
      } catch (err) {
        if (!(err instanceof AfcError)) throw err;
        // Missing or unreadable: try the next layout.
      }
    }

    // Preferred variant absent — see whether another rendition exists.
    const dir = request.isVideo
      ? KEYFRAME_ROOT + '/' + request.assetId
      : V2_ROOT + '/' + request.assetId;
    return this.anyVariant(afc, dir);
  }

  private pump(): void {
    while (this.workers < this.maxWorkers && this.queue.length > 0) {
      this.workers++;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        // Newest request first: the grid's current viewport wins.
        let bestIndex = -1;
        for (let i = this.queue.length - 1; i >= 0; i--) {
          if (bestIndex === -1 || this.queue[i].sequence > this.queue[bestIndex].sequence) {
            bestIndex = i;
          }
        }
        if (bestIndex === -1) return;
        const request = this.queue.splice(bestIndex, 1)[0];

        try {
          const data = await this.pool.run((afc) => this.fetchFromDevice(request, afc));
          if (data && data.length > 0) {
            this.remember(request.assetId, data);
            void fs.promises
              .mkdir(path.dirname(this.diskPath(request.assetId)), { recursive: true })
              .then(() => fs.promises.writeFile(this.diskPath(request.assetId), data))
              .catch(() => undefined);
            request.resolve(data);
          } else {
            this.missing.add(request.assetId);
            request.resolve(null);
          }
        } catch (err) {
          request.reject(err);
        } finally {
          this.inFlight.delete(request.assetId);
        }
      }
    } finally {
      this.workers--;
    }
  }

  async get(assetId: string, isVideo: boolean): Promise<Buffer | null> {
    const cached = this.memory.get(assetId);
    if (cached) {
      // Refresh recency.
      this.memory.delete(assetId);
      this.memory.set(assetId, cached);
      return cached;
    }
    if (this.missing.has(assetId)) return null;

    const existing = this.inFlight.get(assetId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const onDisk = await fs.promises.readFile(this.diskPath(assetId));
        if (onDisk.length > 0) {
          this.remember(assetId, onDisk);
          return onDisk;
        }
      } catch {
        /* not cached yet */
      }

      return new Promise<Buffer | null>((resolve, reject) => {
        this.queue.push({
          assetId,
          isVideo,
          sequence: ++this.sequence,
          resolve,
          reject,
        });
        this.pump();
      });
    })();

    this.inFlight.set(assetId, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(assetId);
    }
  }

  /** Warms the cache ahead of the viewport without blocking foreground reads. */
  prefetch(assetIds: Array<{ id: string; isVideo: boolean }>): void {
    for (const { id, isVideo } of assetIds) {
      if (this.memory.has(id) || this.missing.has(id) || this.inFlight.has(id)) continue;
      void this.get(id, isVideo).catch(() => undefined);
    }
  }

  clearMemory(): void {
    this.memory.clear();
    this.memoryBytes = 0;
    this.missing.clear();
  }
}
