/**
 * Stub bridge for the UI harness.
 *
 * Mirrors the real preload's surface with synthetic data so the renderer can be
 * exercised — grid virtualization, date sections, badges, and the thumb://
 * image path — without a device attached.
 */
import { contextBridge } from 'electron';
import type { Asset, ConnectionState } from '../shared/types';

const KINDS: Array<{ ext: string; kind: Asset['kind'] }> = [
  { ext: 'HEIC', kind: 'photo' },
  { ext: 'JPG', kind: 'photo' },
  { ext: 'MOV', kind: 'video' },
  { ext: 'PNG', kind: 'photo' },
  { ext: 'DNG', kind: 'raw' },
];

function makeAssets(total: number): Asset[] {
  const assets: Asset[] = [];
  const start = Date.UTC(2026, 7, 16, 18, 0, 0);

  for (let i = 0; i < total; i++) {
    // Roughly 40 items per day, newest first.
    const day = Math.floor(i / 40);
    // Extension follows the name index, so repeats are true name collisions.
    const pick = KINDS[i % 8 % KINDS.length];
    // Names repeat across folders, mirroring the camera counter wrapping past
    // IMG_9999 — folder + name stays unique, exactly as it is on the device.
    const folder = String(140 + Math.floor(i / 8)) + 'APPLE';
    const name = 'IMG_' + String(1000 + (i % 8)).padStart(4, '0') + '.' + pick.ext;

    assets.push({
      id: folder + '/' + name,
      folder,
      name,
      ext: pick.ext,
      kind: pick.kind,
      size: 1_200_000 + ((i * 92_821) % 8_000_000),
      mtime: start - day * 86_400_000 - (i % 40) * 240_000,
      live: pick.kind === 'photo' && i % 3 === 0,
      motionPart: false,
    });
  }
  return assets;
}

const assets = makeAssets(2000);

const device: ConnectionState = {
  status: 'ready',
  device: {
    udid: '00008150-0006684C0152401C',
    name: "Alex's iPhone",
    deviceClass: 'iPhone',
    productType: 'iPhone18,2',
    iosVersion: '26.1',
    connectionType: 'USB' as const,
    capacityBytes: 1_024_000_000_000,
    freeBytes: 971_696_971_776,
    batteryLevel: 74,
    batteryCharging: true,
  },
};

const noop = () => () => undefined;

contextBridge.exposeInMainWorld('ios', {
  getState: () => Promise.resolve(device),
  connect: () => Promise.resolve(device),
  disconnect: () => Promise.resolve(),
  probeService: () => Promise.resolve({ reachable: true, deviceCount: 1, daemon: null }),
  startService: () => Promise.resolve({ started: true }),
  scan: () => Promise.resolve({ assets, listMs: 137 }),
  getAssets: () => Promise.resolve(assets),
  prefetchThumbs: () => Promise.resolve(),
  getDurations: (requests: Array<{ id: string; size: number }>) =>
    Promise.resolve(
      Object.fromEntries(
        // Deterministic pseudo-durations so video badges have something to show.
        requests.map(({ id }) => [
          id,
          { seconds: 3 + ((id.length * 37) % 600), width: 1920, height: 1080 },
        ]),
      ),
    ),
  getSettings: () =>
    Promise.resolve({
      destination: 'C:\\Transfers\\iphone',
      organizeByDate: false,
      includeMotion: true,
      onConflict: 'rename',
      preserveDates: true,
    }),
  saveSettings: (value: unknown) => Promise.resolve(value),
  chooseFolder: () => Promise.resolve(null),
  freeSpace: () => Promise.resolve({ free: 1_144_000_000_000 }),
  picturesPath: () => Promise.resolve('C:\\Users\\Public\\Pictures'),
  reveal: () => Promise.resolve(),
  openAsset: (id: string) => Promise.resolve({ path: id, reused: true }),
  startTransfer: () => Promise.resolve({ jobId: 'x', filesTotal: 0, bytesTotal: 0 }),
  cancelTransfer: () => Promise.resolve(),
  onState: noop,
  onScanProgress: (handler: (p: unknown) => void) => {
    setTimeout(
      () => handler({ phase: 'done', assetsFound: assets.length, metadataDone: assets.length, elapsedMs: 1180 }),
      300,
    );
    return () => undefined;
  },
  onMetadata: noop,
  onStats: (handler: (s: unknown) => void) => {
    setTimeout(
      () =>
        handler({
          total: assets.length,
          photos: assets.filter((a) => a.kind === 'photo').length,
          videos: assets.filter((a) => a.kind === 'video').length,
          raw: assets.filter((a) => a.kind === 'raw').length,
          bytes: assets.reduce((n, a) => n + a.size, 0),
        }),
      300,
    );
    return () => undefined;
  },
  onTransferProgress: noop,
  onTransferError: noop,
  onPreviewProgress: noop,
});
