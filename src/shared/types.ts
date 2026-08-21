/** Types crossing the main/renderer boundary. Keep this file dependency-free. */

export type AssetKind = 'photo' | 'video' | 'raw' | 'other';

export interface Asset {
  /** Stable identity, relative to DCIM: "140APPLE/IMG_0639.JPG". */
  id: string;
  folder: string;
  name: string;
  ext: string;
  kind: AssetKind;
  /** Bytes; 0 until the metadata sweep reaches this asset. */
  size: number;
  /** Modification time in ms since epoch; 0 until the sweep reaches it. */
  mtime: number;
  /** A still that has a paired motion file (Live Photo). */
  live: boolean;
  /** The motion half of a Live Photo — hidden from the grid by default. */
  motionPart: boolean;
}

export interface DeviceSummary {
  udid: string;
  name: string;
  deviceClass: string;
  productType: string;
  iosVersion: string;
  connectionType: 'USB' | 'Network';
  capacityBytes: number;
  freeBytes: number;
  batteryLevel: number | null;
  batteryCharging: boolean;
}

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; message: string }
  | { status: 'ready'; device: DeviceSummary }
  | { status: 'error'; message: string; hint?: string };

export interface ScanProgress {
  phase: 'listing' | 'metadata' | 'done';
  assetsFound: number;
  metadataDone: number;
  elapsedMs: number;
}

export interface TransferItem {
  assetId: string;
  name: string;
  size: number;
}

export type TransferStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface TransferProgress {
  jobId: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  destination: string;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  filesSkipped: number;
  bytesTotal: number;
  /** Bytes handed to the OS — drives the progress bar. */
  bytesDone: number;
  /** Bytes belonging to files fully closed on disk — the honest figure. */
  bytesFlushed: number;
  /**
   * Bytes per second, measured from completed files over a long window.
   *
   * Counting buffered writes instead reports whatever the OS write cache will
   * absorb, which on a slow disk reads several times faster than reality.
   */
  bytesPerSecond: number;
  etaSeconds: number | null;
  /** Files being written right now, one per write stream. */
  current: string[];
  /** Concurrent write streams, chosen from the destination medium. */
  writeStreams: number;
  mediaKind: 'ssd' | 'hdd' | 'unknown';
  errors: Array<{ name: string; message: string }>;
}

export interface TransferOptions {
  destination: string;
  /** Group files into dated subfolders on arrival. */
  organizeByDate: boolean;
  /** Also copy the motion half of Live Photos. */
  includeMotion: boolean;
  /** What to do when a file of the same name already exists. */
  onConflict: 'skip' | 'overwrite' | 'rename';
  /** Stamp the copied file with the device's capture time. */
  preserveDates: boolean;
}

export interface LibraryStats {
  total: number;
  photos: number;
  videos: number;
  raw: number;
  bytes: number;
}
