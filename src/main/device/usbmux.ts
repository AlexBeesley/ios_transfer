import net from 'node:net';
import { EventEmitter } from 'node:events';
import { ByteReader, writeAsync } from './framing';
import { buildPlist, parsePlistDict, type PlistDict } from './plist';

/**
 * Client for Apple's USB multiplexer (usbmuxd).
 *
 * On Windows this ships as part of Apple Mobile Device Support (installed by
 * iTunes or the Apple Devices app) and listens on 127.0.0.1:27015. It owns the
 * USB link to the phone and lets us open TCP-like streams to ports on the
 * device, which is what makes full-speed USB 3 transfers possible without
 * touching a USB driver ourselves.
 */

const MUX_PORT = 27015;
const MUX_UNIX_SOCKET = '/var/run/usbmuxd';
const PROTOCOL_VERSION = 1;
const MESSAGE_PLIST = 8;
const CLIENT_LABEL = 'ios-transfer';

export interface DeviceRecord {
  deviceId: number;
  udid: string;
  connectionType: 'USB' | 'Network';
  productId: number;
}

export class UsbmuxError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'UsbmuxError';
  }
}

/** Human-readable meanings for usbmuxd's `Number` result field. */
function describeResult(code: number): string {
  switch (code) {
    case 0: return 'ok';
    case 1: return 'bad command';
    case 2: return 'device not connected';
    case 3: return 'connection refused';
    case 5: return 'bad version';
    default: return 'error ' + code;
  }
}

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      process.platform === 'win32'
        ? net.connect({ port: MUX_PORT, host: '127.0.0.1' })
        : net.connect({ path: MUX_UNIX_SOCKET });

    const onError = (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        reject(
          new UsbmuxError(
            'Could not reach the Apple Mobile Device service. Install the Apple Devices app ' +
              '(or iTunes) from the Microsoft Store and make sure it is running.',
          ),
        );
      } else {
        reject(err);
      }
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

/** Transient conditions worth a retry rather than a failure. */
const RETRYABLE = new Set(['EADDRINUSE', 'ECONNRESET', 'ETIMEDOUT', 'EADDRNOTAVAIL']);

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Opens a socket to usbmuxd, retrying transient failures.
 *
 * Windows only has ~16k ephemeral ports and holds closed ones in TIME_WAIT for
 * two minutes. Any other iOS tool running alongside us (iTunes, the Apple
 * Devices app, iMazing) can exhaust that range, and connect() then fails with
 * EADDRINUSE even though the service is healthy. Backing off briefly rides it
 * out; the app itself avoids adding to the churn by pooling its connections.
 */
async function openSocket(): Promise<net.Socket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await connectOnce();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code)) throw err;
      await delay(Math.min(1000, 60 * 2 ** attempt) + Math.random() * 60);
    }
  }
  const code = (lastError as NodeJS.ErrnoException)?.code;
  if (code === 'EADDRINUSE') {
    throw new UsbmuxError(
      'Windows has run out of free network ports for talking to the phone. This usually means ' +
        'another iOS app (iTunes, Apple Devices or iMazing) is opening connections in a loop — ' +
        'close it and try again.',
    );
  }
  throw lastError instanceof Error ? lastError : new UsbmuxError('could not reach usbmuxd');
}

/** One usbmuxd conversation. Either used for a single request, or upgraded to a device tunnel. */
export class MuxConnection {
  private tag = 0;

  private constructor(
    readonly socket: net.Socket,
    private reader: ByteReader | null,
  ) {}

  static async open(): Promise<MuxConnection> {
    const socket = await openSocket();
    return new MuxConnection(socket, new ByteReader(socket));
  }

  async send(payload: PlistDict): Promise<void> {
    const body = buildPlist({
      ClientVersionString: CLIENT_LABEL,
      ProgName: CLIENT_LABEL,
      kLibUSBMuxVersion: 3,
      ...payload,
    });
    const header = Buffer.alloc(16);
    header.writeUInt32LE(16 + body.length, 0);
    header.writeUInt32LE(PROTOCOL_VERSION, 4);
    header.writeUInt32LE(MESSAGE_PLIST, 8);
    header.writeUInt32LE(++this.tag, 12);
    await writeAsync(this.socket, Buffer.concat([header, body]));
  }

  async receive(): Promise<PlistDict> {
    if (!this.reader) throw new UsbmuxError('connection was upgraded to a device tunnel');
    const header = await this.reader.read(16);
    const length = header.readUInt32LE(0);
    if (length < 16 || length > 8 * 1024 * 1024) {
      throw new UsbmuxError('malformed usbmux frame (length ' + length + ')');
    }
    return parsePlistDict(await this.reader.read(length - 16));
  }

  async request(payload: PlistDict): Promise<PlistDict> {
    await this.send(payload);
    return this.receive();
  }

  /** Releases the socket from plist framing so it can carry a raw device stream. */
  detach(): net.Socket {
    this.reader?.dispose();
    this.reader = null;
    return this.socket;
  }

  close(): void {
    this.reader?.dispose();
    this.reader = null;
    this.socket.destroy();
  }
}

/** Runs a single request/response against usbmuxd and closes the socket. */
async function oneShot(payload: PlistDict): Promise<PlistDict> {
  const conn = await MuxConnection.open();
  try {
    return await conn.request(payload);
  } finally {
    conn.close();
  }
}

export async function listDevices(): Promise<DeviceRecord[]> {
  const reply = await oneShot({ MessageType: 'ListDevices' });
  const list = Array.isArray(reply.DeviceList) ? reply.DeviceList : [];
  const devices: DeviceRecord[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const props = (entry as PlistDict).Properties;
    if (typeof props !== 'object' || props === null || Array.isArray(props)) continue;
    const p = props as PlistDict;
    devices.push({
      deviceId: Number(p.DeviceID ?? (entry as PlistDict).DeviceID ?? 0),
      udid: String(p.SerialNumber ?? ''),
      connectionType: p.ConnectionType === 'Network' ? 'Network' : 'USB',
      productId: Number(p.ProductID ?? 0),
    });
  }
  return devices;
}

export async function readBuid(): Promise<string> {
  const reply = await oneShot({ MessageType: 'ReadBUID' });
  return String(reply.BUID ?? '');
}

/**
 * Fetches the host/device pairing certificates.
 *
 * usbmuxd is asked first; on Windows it usually answers straight from
 * C:\ProgramData\Apple\Lockdown, which the caller can also read directly as a
 * fallback when the service declines.
 */
export async function readPairRecord(udid: string): Promise<PlistDict | null> {
  try {
    const reply = await oneShot({ MessageType: 'ReadPairRecord', PairRecordID: udid });
    const data = reply.PairRecordData;
    if (Buffer.isBuffer(data) && data.length > 0) return parsePlistDict(data);
    return null;
  } catch {
    return null;
  }
}

/**
 * Opens a stream to a TCP port on the device.
 *
 * The returned socket is a raw tunnel: usbmuxd stops interpreting traffic and
 * relays bytes to the device over USB.
 */
export async function connectToDevice(deviceId: number, port: number): Promise<net.Socket> {
  const conn = await MuxConnection.open();
  try {
    // usbmuxd wants the port in network byte order inside a host-order integer.
    const swapped = ((port << 8) & 0xff00) | ((port >> 8) & 0x00ff);
    const reply = await conn.request({
      MessageType: 'Connect',
      DeviceID: deviceId,
      PortNumber: swapped,
    });
    const code = Number(reply.Number ?? -1);
    if (code !== 0) {
      throw new UsbmuxError(
        'usbmuxd refused a connection to device port ' + port + ': ' + describeResult(code),
        code,
      );
    }
    return conn.detach();
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** Emits `attach` / `detach` as devices come and go. */
export class DeviceMonitor extends EventEmitter {
  private conn: MuxConnection | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.stopped = false;
    await this.listen();
  }

  private async listen(): Promise<void> {
    try {
      const conn = await MuxConnection.open();
      this.conn = conn;
      await conn.send({ MessageType: 'Listen' });
      for (;;) {
        const msg = await conn.receive();
        if (this.stopped) return;
        const type = String(msg.MessageType ?? '');
        if (type === 'Attached') {
          const props = msg.Properties as PlistDict | undefined;
          if (props) {
            this.emit('attach', {
              deviceId: Number(props.DeviceID ?? 0),
              udid: String(props.SerialNumber ?? ''),
              connectionType: props.ConnectionType === 'Network' ? 'Network' : 'USB',
              productId: Number(props.ProductID ?? 0),
            } satisfies DeviceRecord);
          }
        } else if (type === 'Detached') {
          this.emit('detach', Number(msg.DeviceID ?? 0));
        }
      }
    } catch (err) {
      this.conn = null;
      if (this.stopped) return;
      this.emit('error', err);
      // The service can restart when a device is replugged; retry quietly.
      setTimeout(() => {
        if (!this.stopped) void this.listen();
      }, 1500);
    }
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
    this.conn = null;
  }
}
