import type { Duplex } from 'node:stream';

/**
 * Promise-based "read exactly N bytes" adapter over a socket.
 *
 * Every protocol in this stack is length-prefixed and strictly
 * request/response, so a single pending reader at a time is enough.
 */
export class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private failure: Error | null = null;
  private waiter: {
    need: number;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  } | null = null;

  private readonly onData = (chunk: Buffer) => {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.pump();
  };
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () => this.fail(new Error('connection closed by peer'));

  constructor(private readonly socket: Duplex) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('end', this.onClose);
  }

  /** Bytes already received but not yet handed out. */
  get pending(): number {
    return this.buffered;
  }

  read(need: number): Promise<Buffer> {
    if (need === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise<Buffer>((resolve, reject) => {
      if (this.waiter) {
        reject(new Error('ByteReader: a read is already in flight'));
        return;
      }
      this.waiter = { need, resolve, reject };
      this.pump();
    });
  }

  private pump(): void {
    const waiter = this.waiter;
    if (!waiter) return;

    if (this.buffered >= waiter.need) {
      const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
      const out = merged.subarray(0, waiter.need);
      const rest = merged.subarray(waiter.need);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      this.waiter = null;
      waiter.resolve(out);
      return;
    }

    if (this.failure) {
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.pump();
    // Nothing buffered can satisfy the waiter any more; reject it outright.
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  /** Stops consuming the socket, e.g. before handing it to a TLS wrapper. */
  dispose(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.off('end', this.onClose);
  }
}

/** Writes a buffer and resolves once it has been flushed to the kernel. */
export function writeAsync(socket: Duplex, data: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}
