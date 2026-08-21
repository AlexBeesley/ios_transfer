import type { Duplex } from 'node:stream';
import { ByteReader, writeAsync } from './framing';

/**
 * AFC — Apple File Conduit.
 *
 * A small binary request/response protocol that exposes the device's media
 * partition (rooted at /var/mobile/Media, so DCIM and PhotoData sit at the
 * top level). One request is in flight per connection, so throughput comes
 * from running several connections in parallel — see AfcPool.
 */

const MAGIC = Buffer.from('CFA6LPAA', 'ascii');
const HEADER_SIZE = 40;

export const AfcOp = {
  Status: 1,
  Data: 2,
  ReadDir: 3,
  RemovePath: 8,
  MakeDir: 9,
  GetFileInfo: 10,
  GetDeviceInfo: 11,
  FileOpen: 13,
  FileOpenResult: 14,
  FileRead: 15,
  FileWrite: 16,
  FileSeek: 17,
  FileClose: 20,
} as const;

/** Scoped read access to one open file, valid only inside {@link AfcClient.withFile}. */
export interface AfcFileHandle {
  read(length: number): Promise<Buffer>;
  seek(offset: number): Promise<void>;
  readAt(offset: number, length: number): Promise<Buffer>;
}

export const AfcMode = {
  ReadOnly: 1,
  ReadWrite: 2,
  WriteOnly: 3,
} as const;

const AFC_ERRORS: Record<number, string> = {
  1: 'unknown error',
  2: 'invalid header',
  3: 'no resources',
  4: 'read error',
  5: 'write error',
  6: 'unknown packet type',
  7: 'invalid argument',
  8: 'no such file or directory',
  9: 'is a directory',
  10: 'permission denied',
  11: 'service not connected',
  12: 'timed out',
  13: 'too much data',
  14: 'end of data',
  15: 'operation not supported',
  16: 'already exists',
  17: 'busy',
  18: 'no space left on device',
  19: 'would block',
  20: 'I/O error',
  21: 'interrupted',
  22: 'in progress',
  23: 'internal error',
};

export class AfcError extends Error {
  constructor(readonly code: number, operation: string, path?: string) {
    super(
      'AFC ' + operation + (path ? ' (' + path + ')' : '') + ': ' +
        (AFC_ERRORS[code] ?? 'error ' + code),
    );
    this.name = 'AfcError';
  }

  get notFound(): boolean {
    return this.code === 8;
  }

  get permissionDenied(): boolean {
    return this.code === 10;
  }
}

export interface AfcFileInfo {
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Modification time in milliseconds since the Unix epoch. */
  mtime: number;
  /** Creation time in milliseconds since the Unix epoch, when reported. */
  birthtime: number;
}

interface AfcPacket {
  operation: number;
  payload: Buffer;
}

/** Splits AFC's NUL-delimited string lists. */
function splitNulList(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.toString('utf8', start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.toString('utf8', start));
  return out;
}

function pairsToMap(entries: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < entries.length; i += 2) map.set(entries[i], entries[i + 1]);
  return map;
}

/** AFC timestamps are nanoseconds since the epoch, delivered as decimal strings. */
function nanosToMillis(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n / 1e6) : 0;
}

export class AfcClient {
  private packetNumber = 0;
  private reader: ByteReader;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly stream: Duplex) {
    this.reader = new ByteReader(stream);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Serializes access to the connection. AFC has no request IDs, so replies are
   * matched purely by order.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    // Keep the chain alive even when a job rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async exchange(
    operation: number,
    header: Buffer,
    body?: Buffer,
  ): Promise<AfcPacket> {
    if (this.closed) throw new Error('AFC connection is closed');

    const thisLength = HEADER_SIZE + header.length;
    const entireLength = thisLength + (body?.length ?? 0);

    const packet = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(packet, 0);
    packet.writeBigUInt64LE(BigInt(entireLength), 8);
    packet.writeBigUInt64LE(BigInt(thisLength), 16);
    packet.writeBigUInt64LE(BigInt(++this.packetNumber), 24);
    packet.writeBigUInt64LE(BigInt(operation), 32);

    const parts = body ? [packet, header, body] : [packet, header];
    await writeAsync(this.stream, Buffer.concat(parts));

    const replyHeader = await this.reader.read(HEADER_SIZE);
    if (!replyHeader.subarray(0, 8).equals(MAGIC)) {
      this.closed = true;
      throw new Error('AFC: bad magic in reply — connection out of sync');
    }
    const replyEntire = Number(replyHeader.readBigUInt64LE(8));
    const replyOp = Number(replyHeader.readBigUInt64LE(32));
    const payloadLength = replyEntire - HEADER_SIZE;
    if (payloadLength < 0 || payloadLength > 512 * 1024 * 1024) {
      this.closed = true;
      throw new Error('AFC: implausible reply length ' + payloadLength);
    }
    const payload = payloadLength > 0 ? await this.reader.read(payloadLength) : Buffer.alloc(0);
    return { operation: replyOp, payload };
  }

  /** Runs an operation and fails unless the device answered with data or success. */
  private async call(
    operation: number,
    header: Buffer,
    label: string,
    subject?: string,
    body?: Buffer,
  ): Promise<Buffer> {
    const reply = await this.exchange(operation, header, body);
    if (reply.operation === AfcOp.Status) {
      const code = reply.payload.length >= 8 ? Number(reply.payload.readBigUInt64LE(0)) : 1;
      if (code !== 0) throw new AfcError(code, label, subject);
      return Buffer.alloc(0);
    }
    return reply.payload;
  }

  private static pathHeader(remotePath: string): Buffer {
    return Buffer.concat([Buffer.from(remotePath, 'utf8'), Buffer.from([0])]);
  }

  async readDirectory(remotePath: string): Promise<string[]> {
    return this.enqueue(async () => {
      const payload = await this.call(
        AfcOp.ReadDir,
        AfcClient.pathHeader(remotePath),
        'read directory',
        remotePath,
      );
      return splitNulList(payload).filter((name) => name !== '.' && name !== '..');
    });
  }

  async stat(remotePath: string): Promise<AfcFileInfo> {
    return this.enqueue(async () => {
      const payload = await this.call(
        AfcOp.GetFileInfo,
        AfcClient.pathHeader(remotePath),
        'stat',
        remotePath,
      );
      const info = pairsToMap(splitNulList(payload));
      const kind = info.get('st_ifmt') ?? '';
      return {
        size: Number(info.get('st_size') ?? 0),
        isDirectory: kind === 'S_IFDIR',
        isSymlink: kind === 'S_IFLNK',
        mtime: nanosToMillis(info.get('st_mtime')),
        birthtime: nanosToMillis(info.get('st_birthtime')),
      } satisfies AfcFileInfo;
    });
  }

  async deviceInfo(): Promise<Map<string, string>> {
    return this.enqueue(async () => {
      const payload = await this.call(AfcOp.GetDeviceInfo, Buffer.alloc(0), 'device info');
      return pairsToMap(splitNulList(payload));
    });
  }

  private async openHandle(remotePath: string, mode: number): Promise<bigint> {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(BigInt(mode), 0);
    const payload = await this.call(
      AfcOp.FileOpen,
      Buffer.concat([header, AfcClient.pathHeader(remotePath)]),
      'open',
      remotePath,
    );
    if (payload.length < 8) throw new Error('AFC: open returned no handle for ' + remotePath);
    return payload.readBigUInt64LE(0);
  }

  private async closeHandle(handle: bigint): Promise<void> {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(handle, 0);
    await this.call(AfcOp.FileClose, header, 'close');
  }

  private async seekHandle(handle: bigint, offset: number): Promise<void> {
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(handle, 0);
    header.writeBigUInt64LE(0n, 8); // whence: SEEK_SET
    header.writeBigInt64LE(BigInt(Math.round(offset)), 16);
    await this.call(AfcOp.FileSeek, header, 'seek');
  }

  /**
   * Opens a file for the duration of `job`, giving it random access.
   *
   * The whole scope runs as one queued unit so the handle cannot interleave
   * with other requests on the same connection.
   */
  async withFile<T>(remotePath: string, job: (file: AfcFileHandle) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      try {
        return await job({
          read: (length) => this.readChunk(handle, length),
          seek: (offset) => this.seekHandle(handle, offset),
          readAt: async (offset, length) => {
            await this.seekHandle(handle, offset);
            return this.readChunk(handle, length);
          },
        });
      } finally {
        await this.closeHandle(handle).catch(() => undefined);
      }
    });
  }

  private async readChunk(handle: bigint, length: number): Promise<Buffer> {
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(handle, 0);
    header.writeBigUInt64LE(BigInt(length), 8);
    const reply = await this.exchange(AfcOp.FileRead, header);
    if (reply.operation === AfcOp.Status) {
      const code = reply.payload.length >= 8 ? Number(reply.payload.readBigUInt64LE(0)) : 1;
      if (code === 0 || code === 14) return Buffer.alloc(0); // success-with-no-data / EOF
      throw new AfcError(code, 'read');
    }
    return reply.payload;
  }

  /**
   * Reads an entire file into memory.
   *
   * Suitable for thumbnails and metadata; use {@link streamFile} for originals.
   */
  async readFile(remotePath: string, chunkSize = 512 * 1024): Promise<Buffer> {
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      try {
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
          const chunk = await this.readChunk(handle, chunkSize);
          if (chunk.length === 0) break;
          parts.push(chunk);
          total += chunk.length;
          if (chunk.length < chunkSize) break;
        }
        return Buffer.concat(parts, total);
      } finally {
        await this.closeHandle(handle).catch(() => undefined);
      }
    });
  }

  /**
   * Streams a file out in chunks, invoking `onChunk` for each.
   *
   * `onChunk` is awaited, so backpressure from the destination naturally slows
   * the device read rather than buffering the whole file in memory.
   */
  async streamFile(
    remotePath: string,
    onChunk: (chunk: Buffer) => void | Promise<void>,
    options: { chunkSize?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    const chunkSize = options.chunkSize ?? 1024 * 1024;
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      let total = 0;
      try {
        for (;;) {
          if (options.signal?.aborted) throw new Error('cancelled');
          const chunk = await this.readChunk(handle, chunkSize);
          if (chunk.length === 0) break;
          total += chunk.length;
          await onChunk(chunk);
          if (chunk.length < chunkSize) break;
        }
        return total;
      } finally {
        await this.closeHandle(handle).catch(() => undefined);
      }
    });
  }

  /** Best-effort existence check that never throws for a missing path. */
  /**
   * Writes a whole file to the media partition.
   *
   * Whether the device permits this at all depends on the path — the AFC root
   * is /var/mobile/Media and parts of it are guarded.
   */
  async writeFile(remotePath: string, data: Buffer, chunkSize = 512 * 1024): Promise<void> {
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.WriteOnly);
      try {
        for (let at = 0; at < data.length; at += chunkSize) {
          const slice = data.subarray(at, Math.min(at + chunkSize, data.length));
          const header = Buffer.alloc(8);
          header.writeBigUInt64LE(handle, 0);
          await this.call(AfcOp.FileWrite, header, 'write', remotePath, slice);
        }
      } finally {
        await this.closeHandle(handle).catch(() => undefined);
      }
    });
  }

  /** Unlinks a file. Directories must already be empty. */
  async removePath(remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      await this.call(
        AfcOp.RemovePath,
        AfcClient.pathHeader(remotePath),
        'remove',
        remotePath,
      );
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch (err) {
      if (err instanceof AfcError) return false;
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.dispose();
    this.stream.destroy();
  }
}
