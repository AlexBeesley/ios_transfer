import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { ByteReader, writeAsync } from './framing';
import { buildPlist, parsePlistDict, type PlistDict } from './plist';
import { connectToDevice, readPairRecord, UsbmuxError } from './usbmux';

/**
 * Client for lockdownd, the device's service-broker on port 62078.
 *
 * Everything interesting (AFC, house arrest, backups) is reached by asking
 * lockdownd to start the service and hand back a port. That requires an
 * authenticated, TLS-protected session built from the pairing certificates the
 * host stored when the user first tapped "Trust This Computer".
 */

const LOCKDOWN_PORT = 62078;
const LABEL = 'ios-transfer';

export class LockdownError extends Error {
  constructor(message: string, readonly kind?: string) {
    super(message);
    this.name = 'LockdownError';
  }
}

export interface PairRecord {
  hostId: string;
  systemBuid: string;
  hostCertificate: string;
  hostPrivateKey: string;
  rootCertificate: string;
}

function asPem(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
  return '';
}

function toPairRecord(dict: PlistDict): PairRecord | null {
  const record: PairRecord = {
    hostId: String(dict.HostID ?? ''),
    systemBuid: String(dict.SystemBUID ?? ''),
    hostCertificate: asPem(dict.HostCertificate),
    hostPrivateKey: asPem(dict.HostPrivateKey),
    rootCertificate: asPem(dict.RootCertificate),
  };
  if (!record.hostId || !record.hostCertificate || !record.hostPrivateKey) return null;
  return record;
}

/** Windows keeps pair records in ProgramData; used when usbmuxd will not hand one over. */
function pairRecordDirectory(): string {
  if (process.platform === 'win32') {
    const base = process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.join(base, 'Apple', 'Lockdown');
  }
  return '/var/db/lockdown';
}

export async function loadPairRecord(udid: string): Promise<PairRecord> {
  const fromService = await readPairRecord(udid);
  if (fromService) {
    const record = toPairRecord(fromService);
    if (record) return record;
  }

  const file = path.join(pairRecordDirectory(), udid + '.plist');
  try {
    const parsed = parsePlistDict(await fs.promises.readFile(file));
    const record = toPairRecord(parsed);
    if (record) {
      if (!record.systemBuid) {
        // Older records keep the BUID in a sibling file.
        try {
          const sys = parsePlistDict(
            await fs.promises.readFile(path.join(pairRecordDirectory(), 'SystemConfiguration.plist')),
          );
          record.systemBuid = String(sys.SystemBUID ?? '');
        } catch {
          /* optional */
        }
      }
      return record;
    }
  } catch {
    /* fall through to the shared error below */
  }

  throw new LockdownError(
    'This iPhone is not paired with this PC yet. Unlock the phone, connect it by cable, and ' +
      'tap "Trust" when prompted.',
    'not-paired',
  );
}

/** TLS option sets tried in order; iOS wants a legacy-friendly handshake. */
const TLS_VARIANTS: tls.ConnectionOptions[] = [
  { minVersion: 'TLSv1' as const },
  { minVersion: 'TLSv1' as const, ciphers: 'ALL:@SECLEVEL=0' },
  {},
];

export interface ServiceDescriptor {
  port: number;
  useSsl: boolean;
}

export class LockdownClient {
  private reader: ByteReader;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private stream: Duplex,
    readonly deviceId: number,
    readonly pairRecord: PairRecord,
  ) {
    this.reader = new ByteReader(stream);
  }

  private async send(payload: PlistDict): Promise<void> {
    const body = buildPlist({ Label: LABEL, ...payload });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    await writeAsync(this.stream, Buffer.concat([header, body]));
  }

  private async receive(): Promise<PlistDict> {
    const header = await this.reader.read(4);
    const length = header.readUInt32BE(0);
    if (length === 0 || length > 32 * 1024 * 1024) {
      throw new LockdownError('malformed lockdown frame (length ' + length + ')');
    }
    const reply = parsePlistDict(await this.reader.read(length));
    if (reply.Error) {
      throw new LockdownError('lockdown refused the request: ' + String(reply.Error), String(reply.Error));
    }
    return reply;
  }

  /**
   * Sends one request and waits for its reply.
   *
   * lockdown has no request IDs — replies are matched by arrival order — so
   * calls are serialized. Without this, concurrent callers interleave their
   * writes and then race for each other's replies, which leaves the connection
   * permanently out of sync.
   */
  private request(payload: PlistDict): Promise<PlistDict> {
    const run = this.queue.then(
      () => this.sendAndReceive(payload),
      () => this.sendAndReceive(payload),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendAndReceive(payload: PlistDict): Promise<PlistDict> {
    await this.send(payload);
    return this.receive();
  }

  /** Opens a lockdown connection and brings up an authenticated TLS session. */
  static async connect(deviceId: number, pairRecord: PairRecord): Promise<LockdownClient> {
    let lastError: unknown = null;

    for (const variant of TLS_VARIANTS) {
      let socket: net.Socket | null = null;
      try {
        socket = await connectToDevice(deviceId, LOCKDOWN_PORT);
        const client = new LockdownClient(socket, deviceId, pairRecord);

        const type = await client.request({ Request: 'QueryType' });
        if (String(type.Type ?? '') !== 'com.apple.mobile.lockdown') {
          throw new LockdownError('unexpected service on the lockdown port: ' + String(type.Type));
        }

        const session = await client.request({
          Request: 'StartSession',
          HostID: pairRecord.hostId,
          SystemBUID: pairRecord.systemBuid,
        });

        if (session.EnableSessionSSL === true) {
          await client.upgradeToTls(variant);
        }
        return client;
      } catch (err) {
        socket?.destroy();
        lastError = err;
        // A pairing problem will not be fixed by a different cipher list.
        if (err instanceof LockdownError && err.kind) throw err;
        if (err instanceof UsbmuxError) throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LockdownError('could not establish a lockdown session');
  }

  private upgradeToTls(variant: tls.ConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Hand the raw socket over cleanly: stop our framing reader first.
      this.reader.dispose();
      const plain = this.stream as net.Socket;

      let secure: tls.TLSSocket;
      try {
        secure = tls.connect({
          socket: plain,
          key: this.pairRecord.hostPrivateKey,
          cert: this.pairRecord.hostCertificate,
          // The device presents a self-signed certificate from its own pairing
          // authority; trust is established by the client certificate instead.
          rejectUnauthorized: false,
          ...variant,
        });
      } catch (err) {
        reject(err);
        return;
      }

      const onError = (err: Error) => {
        secure.destroy();
        reject(err);
      };
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.off('error', onError);
        secure.setNoDelay(true);
        this.stream = secure;
        this.reader = new ByteReader(secure);
        resolve();
      });
    });
  }

  async getValue(key?: string, domain?: string): Promise<unknown> {
    const payload: PlistDict = { Request: 'GetValue' };
    if (key) payload.Key = key;
    if (domain) payload.Domain = domain;
    const reply = await this.request(payload);
    return reply.Value;
  }

  async startService(service: string): Promise<ServiceDescriptor> {
    const reply = await this.request({ Request: 'StartService', Service: service });
    const port = Number(reply.Port ?? 0);
    if (!port) throw new LockdownError('lockdown did not return a port for ' + service);
    return { port, useSsl: reply.EnableServiceSSL === true };
  }

  /** Opens a fresh stream to a service started via {@link startService}. */
  async openServiceStream(service: string): Promise<Duplex> {
    const descriptor = await this.startService(service);
    const socket = await connectToDevice(this.deviceId, descriptor.port);
    if (!descriptor.useSsl) return socket;

    return new Promise<Duplex>((resolve, reject) => {
      const secure = tls.connect({
        socket,
        key: this.pairRecord.hostPrivateKey,
        cert: this.pairRecord.hostCertificate,
        rejectUnauthorized: false,
        minVersion: 'TLSv1',
      });
      const onError = (err: Error) => {
        secure.destroy();
        reject(err);
      };
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.off('error', onError);
        secure.setNoDelay(true);
        resolve(secure);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.dispose();
    this.stream.destroy();
  }
}
