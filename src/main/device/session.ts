import { AfcClient } from './afc';
import { LockdownClient, loadPairRecord } from './lockdown';
import { listDevices, type DeviceRecord } from './usbmux';

/**
 * A live connection to one device: an authenticated lockdown session plus a
 * pool of AFC connections.
 *
 * AFC allows a single outstanding request per connection, so all of the app's
 * speed comes from spreading work across a pool. Measured on an iPhone 17 Pro
 * over USB 3: ~4.5k stats/s at 6 connections rising to ~6.2k at 16, ~1.2k
 * thumbnails/s, and ~104 MB/s of bulk file reads.
 */

const POOL_SIZE = 16;

/**
 * Connections held back from background work.
 *
 * The metadata sweep would otherwise hold every lane for its full run and the
 * grid would show empty tiles until it finished — the thumbnails the user is
 * actually looking at must never queue behind it.
 */
const FOREGROUND_RESERVE = 6;

export interface DeviceInfo {
  udid: string;
  deviceId: number;
  name: string;
  deviceClass: string;
  productType: string;
  iosVersion: string;
  /** How this device is reachable — USB is roughly 35x faster than Wi-Fi. */
  connectionType: 'USB' | 'Network';
  capacityBytes: number;
  freeBytes: number;
  batteryLevel: number | null;
  batteryCharging: boolean;
}

/** Hands out AFC connections, opening them lazily up to a ceiling. */
export class AfcPool {
  private all: AfcClient[] = [];
  private idle: AfcClient[] = [];
  private waiters: Array<(client: AfcClient) => void> = [];
  private opening = 0;
  private closed = false;

  constructor(
    private readonly lockdown: LockdownClient,
    readonly max: number,
  ) {}

  get size(): number {
    return this.all.length;
  }

  /** Lane budget for background work, leaving headroom for the viewport. */
  get backgroundLanes(): number {
    return Math.max(2, this.max - FOREGROUND_RESERVE);
  }

  private async acquire(): Promise<AfcClient> {
    if (this.closed) throw new Error('device session closed');

    const ready = this.idle.pop();
    if (ready && !ready.isClosed) return ready;

    if (this.all.length + this.opening < this.max) {
      this.opening++;
      try {
        const client = new AfcClient(await this.lockdown.openServiceStream('com.apple.afc'));
        this.all.push(client);
        return client;
      } finally {
        this.opening--;
      }
    }

    return new Promise<AfcClient>((resolve) => this.waiters.push(resolve));
  }

  private release(client: AfcClient): void {
    if (this.closed || client.isClosed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(client);
    else this.idle.push(client);
  }

  /** Runs one operation on a pooled connection. */
  async run<T>(job: (afc: AfcClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    try {
      return await job(client);
    } finally {
      this.release(client);
    }
  }

  /**
   * Runs `job` over every item with the pool saturated.
   *
   * Results keep the input order. `onProgress` fires as each item settles so
   * callers can stream partial results to the UI.
   */
  async map<T, R>(
    items: readonly T[],
    job: (afc: AfcClient, item: T, index: number) => Promise<R>,
    options: {
      concurrency?: number;
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
      onError?: (item: T, index: number, err: unknown) => void;
    } = {},
  ): Promise<Array<R | undefined>> {
    const results: Array<R | undefined> = new Array(items.length);
    if (items.length === 0) return results;

    const lanes = Math.min(options.concurrency ?? this.max, this.max, items.length);
    let cursor = 0;
    let done = 0;

    await Promise.all(
      Array.from({ length: lanes }, async () => {
        const client = await this.acquire();
        try {
          for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            if (options.signal?.aborted) return;
            try {
              results[index] = await job(client, items[index], index);
            } catch (err) {
              options.onError?.(items[index], index, err);
            }
            options.onProgress?.(++done, items.length);
          }
        } finally {
          this.release(client);
        }
      }),
    );
    return results;
  }

  close(): void {
    this.closed = true;
    for (const client of this.all) client.close();
    this.all = [];
    this.idle = [];
    this.waiters = [];
  }
}

export class DeviceSession {
  private constructor(
    readonly info: DeviceInfo,
    private readonly lockdown: LockdownClient,
    readonly pool: AfcPool,
  ) {}

  static async open(record: DeviceRecord): Promise<DeviceSession> {
    const pairRecord = await loadPairRecord(record.udid);
    const lockdown = await LockdownClient.connect(record.deviceId, pairRecord);

    try {
      const value = async (key: string): Promise<string> => {
        try {
          return String((await lockdown.getValue(key)) ?? '');
        } catch {
          return '';
        }
      };
      const domain = async (name: string): Promise<Record<string, unknown>> => {
        try {
          return ((await lockdown.getValue(undefined, name)) ?? {}) as Record<string, unknown>;
        } catch {
          return {};
        }
      };

      const [name, deviceClass, productType, iosVersion] = await Promise.all([
        value('DeviceName'),
        value('DeviceClass'),
        value('ProductType'),
        value('ProductVersion'),
      ]);
      const disk = await domain('com.apple.disk_usage');
      const battery = await domain('com.apple.mobile.battery');

      const info: DeviceInfo = {
        udid: record.udid,
        deviceId: record.deviceId,
        name: name || 'iPhone',
        deviceClass: deviceClass || 'iPhone',
        productType,
        iosVersion,
        connectionType: record.connectionType,
        capacityBytes: Number(disk.TotalDiskCapacity ?? 0),
        // AmountDataAvailable is the real free space on the data partition.
        // TotalDataAvailable looks like an answer but is not one — on a 1 TB
        // iPhone holding 790 GB of media it still reports ~972 GB. Only
        // AmountDataAvailable agrees with what AFC reports for the same volume.
        freeBytes: Number(disk.AmountDataAvailable ?? disk.TotalDataAvailable ?? 0),
        batteryLevel:
          typeof battery.BatteryCurrentCapacity === 'number'
            ? battery.BatteryCurrentCapacity
            : null,
        batteryCharging: battery.BatteryIsCharging === true,
      };

      return new DeviceSession(info, lockdown, new AfcPool(lockdown, POOL_SIZE));
    } catch (err) {
      lockdown.close();
      throw err;
    }
  }

  close(): void {
    this.pool.close();
    this.lockdown.close();
  }
}

/** Returns the first cable-attached device, if any. */
export async function findAttachedDevice(): Promise<DeviceRecord | null> {
  const devices = await listDevices();
  return devices.find((d) => d.connectionType === 'USB') ?? devices[0] ?? null;
}
