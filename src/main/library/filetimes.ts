import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Stamps Windows' "Date created" on copied files.
 *
 * Node can set access and modified times, but not creation time — and that is
 * the column Explorer sorts by out of the box, so without this every imported
 * photo looks like it was created the moment it was copied. There is no Node
 * API for it, so the work is batched out to one PowerShell process per chunk
 * rather than one per file.
 */

const CHUNK = 400;

export class CreationTimeWriter {
  private pending: Array<{ file: string; when: number }> = [];
  private failed = 0;

  constructor(private readonly enabled: boolean) {}

  get failures(): number {
    return this.failed;
  }

  add(file: string, when: number): void {
    if (!this.enabled || !when) return;
    this.pending.push({ file, when });
  }

  /** Whether enough has queued up to be worth spawning a process. */
  get shouldFlush(): boolean {
    return this.pending.length >= CHUNK;
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    // The list goes through a temp file: a 400-entry command line would blow
    // past the Windows limit, and paths can contain quotes.
    const listFile = path.join(
      os.tmpdir(),
      'ios-transfer-times-' + process.pid + '-' + Date.now() + '.txt',
    );
    const body = batch.map((entry) => entry.file + '\t' + Math.round(entry.when)).join('\r\n');

    try {
      await fs.promises.writeFile(listFile, body, 'utf8');
      await this.run(listFile);
    } catch {
      this.failed += batch.length;
    } finally {
      await fs.promises.rm(listFile, { force: true }).catch(() => undefined);
    }
  }

  private run(listFile: string): Promise<void> {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      'foreach ($line in [System.IO.File]::ReadAllLines(' +
      JSON.stringify(listFile) +
      ")) {" +
      "  if (-not $line) { continue }" +
      "  $i = $line.IndexOf([char]9);" +
      "  if ($i -lt 0) { continue }" +
      '  $p = $line.Substring(0, $i);' +
      '  $ms = [int64]$line.Substring($i + 1);' +
      '  $when = [System.DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime;' +
      '  try {' +
      '    [System.IO.File]::SetCreationTime($p, $when);' +
      '    [System.IO.File]::SetLastWriteTime($p, $when);' +
      '  } catch {}' +
      '}';

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 60_000, windowsHide: true },
        () => resolve(),
      );
    });
  }
}
