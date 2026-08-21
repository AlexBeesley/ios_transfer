import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Works out whether a destination sits on spinning rust.
 *
 * Write concurrency has to match the medium. An SSD is happiest with several
 * streams in flight; a hard disk — especially a shingled one — is destroyed by
 * them, because interleaved streams turn a sequential write into head seeking
 * across the platter. Measured on a Seagate ST2000DM008 (SMR): six concurrent
 * streams gave 48 MB/s at a ~5 second average response time.
 */

export type MediaKind = 'ssd' | 'hdd' | 'unknown';

const cache = new Map<string, MediaKind>();

/** Streams to run for a given medium. */
export function writeStreamsFor(kind: MediaKind): number {
  switch (kind) {
    case 'ssd':
      return 6;
    case 'hdd':
      return 1;
    default:
      return 3;
  }
}

function queryWindows(driveLetter: string): Promise<MediaKind> {
  const script =
    '$ErrorActionPreference="Stop";' +
    '$n=(Get-Partition -DriveLetter ' + driveLetter + ').DiskNumber;' +
    '(Get-PhysicalDisk | Where-Object DeviceId -eq $n).MediaType';

  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 6000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('unknown');
          return;
        }
        const answer = String(stdout).trim().toLowerCase();
        if (answer.includes('ssd')) resolve('ssd');
        else if (answer.includes('hdd')) resolve('hdd');
        else resolve('unknown');
      },
    );
    child.on('error', () => resolve('unknown'));
  });
}

/** Cached per drive letter; the answer cannot change while the app runs. */
export async function detectMedia(destination: string): Promise<MediaKind> {
  if (process.platform !== 'win32') return 'unknown';

  const root = path.parse(path.resolve(destination)).root; // "D:\"
  const letter = root.replace(/[:\\/]/g, '').toUpperCase();
  if (!/^[A-Z]$/.test(letter)) return 'unknown';

  const cached = cache.get(letter);
  if (cached) return cached;

  const kind = await queryWindows(letter);
  cache.set(letter, kind);
  return kind;
}
