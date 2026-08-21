import type { AfcPool } from '../device/session';
import type { Asset, AssetKind, LibraryStats } from '../../shared/types';

/**
 * Builds the asset index from the device's DCIM tree.
 *
 * Listing is fast enough to be effectively instant (46 folders / 35k files in
 * ~40ms on the test device), so the UI gets a complete grid immediately and the
 * per-file metadata sweep — which is an order of magnitude slower — streams in
 * behind it.
 */

const DCIM = '/DCIM';
const CAMERA_FOLDER = /^\d{3}[A-Z]+$/;

const PHOTO_EXT = new Set(['JPG', 'JPEG', 'HEIC', 'HEIF', 'PNG', 'GIF', 'WEBP', 'BMP', 'TIFF']);
const VIDEO_EXT = new Set(['MOV', 'MP4', 'M4V', 'AVI']);
const RAW_EXT = new Set(['DNG', 'RAW', 'CR2', 'NEF', 'ARW']);
/** Sidecars describing non-destructive edits; not assets in their own right. */
const SIDECAR_EXT = new Set(['AAE']);

function classify(ext: string): AssetKind {
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (RAW_EXT.has(ext)) return 'raw';
  return 'other';
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toUpperCase();
}

/**
 * Newest-first ordering that works before capture dates are known.
 *
 * Apple allocates DCIM folders and IMG_ numbers in ascending order, so the path
 * itself is a good chronological proxy. Once mtimes arrive the UI re-sorts on
 * the real values.
 */
function compareByPath(a: Asset, b: Asset): number {
  if (a.folder !== b.folder) return b.folder.localeCompare(a.folder);
  return b.name.localeCompare(a.name);
}

export interface ScanResult {
  assets: Asset[];
  folders: string[];
  listMs: number;
}

export async function scanLibrary(
  pool: AfcPool,
  options: { signal?: AbortSignal } = {},
): Promise<ScanResult> {
  const started = Date.now();

  const entries = await pool.run((afc) => afc.readDirectory(DCIM));
  const folders = entries.filter((e) => CAMERA_FOLDER.test(e)).sort();

  const listings = await pool.map(
    folders,
    async (afc, folder) => ({ folder, names: await afc.readDirectory(DCIM + '/' + folder) }),
    { signal: options.signal },
  );

  const assets: Asset[] = [];
  for (const listing of listings) {
    if (!listing) continue;
    const { folder, names } = listing;

    // Live Photos arrive as a still plus a same-named .MOV in the same folder,
    // so a basename present on both sides identifies the pair.
    const stillBases = new Set<string>();
    const motionBases = new Set<string>();
    for (const name of names) {
      const ext = extensionOf(name);
      if (PHOTO_EXT.has(ext) || RAW_EXT.has(ext)) stillBases.add(baseName(name));
      else if (VIDEO_EXT.has(ext)) motionBases.add(baseName(name));
    }

    for (const name of names) {
      const ext = extensionOf(name);
      if (SIDECAR_EXT.has(ext)) continue;
      const kind = classify(ext);
      const base = baseName(name);

      assets.push({
        id: folder + '/' + name,
        folder,
        name,
        ext,
        kind,
        size: 0,
        mtime: 0,
        live: kind !== 'video' && motionBases.has(base),
        motionPart: kind === 'video' && stillBases.has(base),
      });
    }
  }

  assets.sort(compareByPath);
  return { assets, folders, listMs: Date.now() - started };
}

/**
 * Fills in size and capture time for each asset.
 *
 * Reports back in batches so the renderer can update without a message per
 * file; at ~5k stats/second a per-file channel would be pure overhead.
 */
export async function loadMetadata(
  pool: AfcPool,
  assets: Asset[],
  options: {
    signal?: AbortSignal;
    onBatch?: (updates: Array<{ id: string; size: number; mtime: number }>) => void;
    batchSize?: number;
  } = {},
): Promise<void> {
  const batchSize = options.batchSize ?? 750;
  let batch: Array<{ id: string; size: number; mtime: number }> = [];

  const flush = () => {
    if (batch.length === 0) return;
    options.onBatch?.(batch);
    batch = [];
  };

  await pool.map(
    assets,
    async (afc, asset) => {
      if (asset.size > 0 && asset.mtime > 0) return;
      const info = await afc.stat(DCIM + '/' + asset.id);
      // Prefer birthtime: mtime moves when the file is edited in place.
      const when = info.birthtime || info.mtime;
      asset.size = info.size;
      asset.mtime = when;
      batch.push({ id: asset.id, size: info.size, mtime: when });
      if (batch.length >= batchSize) flush();
    },
    // Deliberately below the pool ceiling: thumbnails for the visible grid must
    // still find a free connection while this runs.
    { signal: options.signal, concurrency: pool.backgroundLanes },
  );

  flush();
}

export function summarize(assets: Asset[]): LibraryStats {
  const stats: LibraryStats = { total: 0, photos: 0, videos: 0, raw: 0, bytes: 0 };
  for (const asset of assets) {
    if (asset.motionPart) continue;
    stats.total++;
    stats.bytes += asset.size;
    if (asset.kind === 'photo') stats.photos++;
    else if (asset.kind === 'video') stats.videos++;
    else if (asset.kind === 'raw') stats.raw++;
  }
  return stats;
}

export const dcimPath = (assetId: string): string => DCIM + '/' + assetId;
