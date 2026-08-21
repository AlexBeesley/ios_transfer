import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import type { AfcClient } from '../device/afc';
import type { AfcPool } from '../device/session';
import { dcimPath } from './scanner';
import { detectMedia, writeStreamsFor, type MediaKind } from './diskinfo';
import { CreationTimeWriter } from './filetimes';
import type { Asset, TransferOptions, TransferProgress } from '../../shared/types';

/**
 * Copies assets off the device.
 *
 * Files are fanned out across the AFC pool and streamed straight to disk, so
 * memory stays flat regardless of file size and the USB link stays saturated
 * (~104 MB/s measured across 6 connections). Each file lands in a temporary
 * name and is renamed on completion, so a cancelled or failed transfer never
 * leaves a truncated file that looks finished.
 */

const CHUNK_SIZE = 1024 * 1024;
/**
 * Trailing window for the throughput readout.
 *
 * Long on purpose: the figure is built from completed files, and a short window
 * would swing wildly between one large file finishing and the next.
 */
const RATE_WINDOW_MS = 30_000;

function two(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function dateFolder(mtime: number): string {
  if (!mtime) return 'Undated';
  const d = new Date(mtime);
  return d.getFullYear() + '\\' + d.getFullYear() + '-' + two(d.getMonth() + 1);
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}

export interface TransferRequest {
  assets: Asset[];
  options: TransferOptions;
}

export class TransferJob extends EventEmitter {
  private readonly controller = new AbortController();
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private readonly current = new Set<string>();
  private readonly errors: Array<{ name: string; message: string }> = [];
  /** Destination paths handed out so far, so lanes cannot collide on a name. */
  private readonly claimed = new Set<string>();
  private naming: Promise<unknown> = Promise.resolve();
  private mediaKind: MediaKind = 'unknown';
  private startedAt = Date.now();
  private readonly creationTimes: CreationTimeWriter;

  private bytesFlushed = 0;
  private writeStreams = 1;
  private filesDone = 0;
  private filesFailed = 0;
  private filesSkipped = 0;
  private bytesDone = 0;
  private finished = false;
  private lastEmit = 0;

  readonly bytesTotal: number;
  readonly filesTotal: number;

  constructor(
    readonly jobId: string,
    private readonly pool: AfcPool,
    private readonly assets: Asset[],
    private readonly options: TransferOptions,
  ) {
    super();
    this.filesTotal = assets.length;
    this.bytesTotal = assets.reduce((n, a) => n + a.size, 0);
    this.creationTimes = new CreationTimeWriter(options.preserveDates);
  }

  cancel(): void {
    this.controller.abort();
  }

  /**
   * Throughput from files that have actually landed.
   *
   * Writes are counted when a file is closed and renamed, not when its bytes
   * are handed to the OS — Windows acknowledges buffered writes immediately, so
   * counting those reports cache absorption rather than disk speed.
   */
  private rate(): number {
    const now = Date.now();
    while (this.samples.length > 0 && now - this.samples[0].at > RATE_WINDOW_MS) {
      this.samples.shift();
    }
    if (this.samples.length === 0) return 0;

    // Divide by the elapsed slice of the window, not the gap between samples.
    // Using the first sample's timestamp makes one just-finished file look
    // infinitely fast, because almost no time has passed since it landed.
    const windowStart = Math.max(this.startedAt, now - RATE_WINDOW_MS);
    const span = (now - windowStart) / 1000;
    if (span < 1) return 0;

    const bytes = this.samples.reduce((n, s) => n + s.bytes, 0);
    return bytes / span;
  }

  private snapshot(status: TransferProgress['status']): TransferProgress {
    const bytesPerSecond = this.rate();
    const remaining = Math.max(0, this.bytesTotal - this.bytesDone);
    return {
      jobId: this.jobId,
      status,
      destination: this.options.destination,
      filesTotal: this.filesTotal,
      filesDone: this.filesDone,
      filesFailed: this.filesFailed,
      filesSkipped: this.filesSkipped,
      bytesTotal: this.bytesTotal,
      bytesDone: this.bytesDone,
      bytesFlushed: this.bytesFlushed,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null,
      current: [...this.current],
      writeStreams: this.writeStreams,
      mediaKind: this.mediaKind,
      errors: this.errors.slice(-25),
    };
  }

  /** Throttled so a fast transfer does not flood the renderer. */
  private publish(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 120) return;
    this.lastEmit = now;
    this.emit('progress', this.snapshot('running'));
  }

  /**
   * Picks the file's destination, one caller at a time.
   *
   * Naming has to be serialized against the other lanes. Checking that a name
   * is free and then streaming to it takes seconds, and iPhone file names
   * repeat across DCIM folders once the camera counter wraps past IMG_9999 —
   * so without this, two lanes copying the same name both see it as free and
   * write over each other, losing files with nothing reported as failed.
   */
  private reserveDestination(asset: Asset): Promise<string | null> {
    const run = this.naming.then(() => this.chooseDestination(asset));
    this.naming = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Treats an existing file as this asset already copied.
   *
   * Same name, same byte count and — when dates are being preserved — the same
   * capture time. That is what makes a cancelled copy resumable: re-running it
   * steps over what already arrived instead of duplicating it.
   */
  private isAlreadyCopied(info: fs.Stats, asset: Asset): boolean {
    if (info.size !== asset.size || asset.size === 0) return false;
    if (!this.options.preserveDates || !asset.mtime) return true;
    return Math.abs(info.mtimeMs - asset.mtime) < 2000;
  }

  private async chooseDestination(asset: Asset): Promise<string | null> {
    const dir = this.options.organizeByDate
      ? path.join(this.options.destination, dateFolder(asset.mtime))
      : this.options.destination;
    await fs.promises.mkdir(dir, { recursive: true });

    const base = path.join(dir, asset.name);
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    // "Replace" means the user wants a fresh copy, so resume-skipping is off.
    const resumable = this.options.onConflict !== 'overwrite';

    for (let index = 0; index < 10000; index++) {
      const candidate =
        index === 0 ? base : path.join(dir, stem + ' (' + index + ')' + ext);

      // Another lane owns this name but has not written it yet.
      if (this.claimed.has(candidate)) {
        if (this.options.onConflict === 'skip') return null;
        continue;
      }

      const info = await statOrNull(candidate);
      if (!info) {
        this.claimed.add(candidate);
        return candidate;
      }

      if (resumable && this.isAlreadyCopied(info, asset)) return null;

      switch (this.options.onConflict) {
        case 'skip':
          return null;
        case 'overwrite':
          this.claimed.add(candidate);
          return candidate;
        case 'rename':
          continue; // try the next "name (n)"
      }
    }

    const fallback = path.join(dir, stem + '-' + Date.now() + ext);
    this.claimed.add(fallback);
    return fallback;
  }

  private async copyOne(afc: AfcClient, asset: Asset): Promise<void> {
    const target = await this.reserveDestination(asset);
    if (target === null) {
      this.filesSkipped++;
      return;
    }

    const temp = target + '.part';
    const sink = fs.createWriteStream(temp);
    this.current.add(asset.name);
    this.publish();

    try {
      await afc.streamFile(
        dcimPath(asset.id),
        async (chunk) => {
          if (!sink.write(chunk)) await once(sink, 'drain');
          this.bytesDone += chunk.length;
          this.publish();
        },
        { chunkSize: CHUNK_SIZE, signal: this.controller.signal },
      );

      await new Promise<void>((resolve, reject) => {
        sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      await fs.promises.rename(temp, target);

      if (this.options.preserveDates && asset.mtime) {
        const when = new Date(asset.mtime);
        await fs.promises.utimes(target, when, when).catch(() => undefined);
        // Explorer sorts on "Date created", which utimes cannot touch.
        this.creationTimes.add(target, asset.mtime);
        if (this.creationTimes.shouldFlush) await this.creationTimes.flush();
      }
      this.filesDone++;
      this.bytesFlushed += asset.size;
      this.samples.push({ at: Date.now(), bytes: asset.size });
    } catch (err) {
      sink.destroy();
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      if (this.controller.signal.aborted) throw err;
      this.filesFailed++;
      this.errors.push({ name: asset.name, message: (err as Error).message });
    } finally {
      this.current.delete(asset.name);
      this.publish();
    }
  }

  async run(): Promise<TransferProgress> {
    this.startedAt = Date.now();
    await fs.promises.mkdir(this.options.destination, { recursive: true });
    this.publish(true);

    // Match write concurrency to the destination medium. Several streams keep
    // an SSD busy, but on a hard disk they turn one sequential write into head
    // seeking between files and throughput collapses.
    const media = await detectMedia(this.options.destination);
    this.mediaKind = media;
    const lanes = writeStreamsFor(media);
    this.writeStreams = lanes;
    this.publish(true);

    try {
      await this.pool.map(
        this.assets,
        (afc, asset) => this.copyOne(afc, asset),
        { concurrency: lanes, signal: this.controller.signal },
      );
    } catch {
      /* cancellation surfaces through the signal check below */
    }

    // Any stragglers still need their creation time, including after a cancel.
    await this.creationTimes.flush();

    this.finished = true;
    const status: TransferProgress['status'] = this.controller.signal.aborted
      ? 'cancelled'
      : this.filesFailed > 0 && this.filesDone === 0
        ? 'failed'
        : 'done';
    const final = this.snapshot(status);
    this.emit('progress', final);
    this.emit('finished', final);
    return final;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

/**
 * Expands a selection into the files that will actually be copied.
 *
 * The grid hides the motion half of Live Photos, so it is added back here when
 * requested — otherwise the copy silently drops half of each Live Photo.
 */
export function expandSelection(
  selected: Asset[],
  all: Asset[],
  includeMotion: boolean,
): Asset[] {
  if (!includeMotion) return selected;

  const byId = new Map(all.map((a) => [a.id, a]));
  const chosen = new Map(selected.map((a) => [a.id, a]));

  for (const asset of selected) {
    if (!asset.live) continue;
    const stem = asset.name.replace(/\.[^.]+$/, '');
    for (const ext of ['MOV', 'mov', 'MP4', 'mp4']) {
      const partner = byId.get(asset.folder + '/' + stem + '.' + ext);
      if (partner && !chosen.has(partner.id)) {
        chosen.set(partner.id, partner);
        break;
      }
    }
  }
  return [...chosen.values()];
}
