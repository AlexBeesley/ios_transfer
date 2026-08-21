import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DeviceMonitor, listDevices, UsbmuxError } from './device/usbmux';
import { DeviceSession, findAttachedDevice } from './device/session';
import { LockdownError } from './device/lockdown';
import { loadMetadata, scanLibrary, summarize } from './library/scanner';
import { ThumbnailService } from './library/thumbnails';
import { DurationService } from './library/duration';
import { expandSelection, TransferJob } from './library/transfer';
import { CreationTimeWriter } from './library/filetimes';
import { loadBounds, loadSettings, saveBounds, saveSettings } from './settings';
import type {
  Asset,
  ConnectionState,
  DeviceSummary,
  TransferOptions,
} from '../shared/types';

/**
 * Application shell: owns the device session, exposes it to the renderer over
 * IPC, and serves thumbnails through a custom protocol so image bytes never
 * cross the IPC bridge.
 */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

/** Must match the header height in the stylesheet. */
const TITLE_BAR_HEIGHT = 44;

let window: BrowserWindow | null = null;
let session: DeviceSession | null = null;
let thumbnails: ThumbnailService | null = null;
let durations: DurationService | null = null;
let assets: Asset[] = [];
let assetsById = new Map<string, Asset>();
let connection: ConnectionState = { status: 'idle' };
let scanAbort: AbortController | null = null;
const jobs = new Map<string, TransferJob>();

const send = (channel: string, payload: unknown): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

function setConnection(next: ConnectionState): void {
  connection = next;
  send('device:state', next);
}

function toSummary(session: DeviceSession): DeviceSummary {
  const { info } = session;
  return {
    udid: info.udid,
    name: info.name,
    deviceClass: info.deviceClass,
    productType: info.productType,
    iosVersion: info.iosVersion,
    connectionType: info.connectionType,
    capacityBytes: info.capacityBytes,
    freeBytes: info.freeBytes,
    batteryLevel: info.batteryLevel,
    batteryCharging: info.batteryCharging,
  };
}

/* ------------------------------------------------------- device lifecycle */

function describeFailure(err: unknown): { message: string; hint?: string } {
  if (err instanceof LockdownError && err.kind === 'not-paired') {
    return {
      message: 'This iPhone has not been trusted on this PC.',
      hint: 'Unlock the phone, keep it connected, and tap Trust when it asks.',
    };
  }
  if (err instanceof UsbmuxError) {
    return {
      message: err.message,
      hint: 'The Apple Devices app (or iTunes) provides the USB service this app talks to.',
    };
  }
  return { message: (err as Error)?.message ?? 'Could not connect to the device.' };
}

async function teardownSession(): Promise<void> {
  scanAbort?.abort();
  scanAbort = null;
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  session?.close();
  session = null;
  thumbnails = null;
  durations = null;
  assets = [];
  assetsById = new Map();
}

async function connectDevice(): Promise<ConnectionState> {
  if (session) return connection;
  setConnection({ status: 'connecting', message: 'Looking for a connected iPhone…' });

  try {
    const record = await findAttachedDevice();
    if (!record) {
      setConnection({
        status: 'error',
        message: 'No iPhone detected.',
        hint: 'Connect your iPhone with a USB cable and unlock it.',
      });
      return connection;
    }

    setConnection({ status: 'connecting', message: 'Pairing with ' + record.udid.slice(0, 8) + '…' });
    session = await DeviceSession.open(record);

    const cacheDir = path.join(app.getPath('userData'), 'thumbnails', session.info.udid);
    thumbnails = new ThumbnailService(session.pool, cacheDir);
    durations = new DurationService(session.pool, cacheDir);

    setConnection({ status: 'ready', device: toSummary(session) });
  } catch (err) {
    await teardownSession();
    const { message, hint } = describeFailure(err);
    setConnection({ status: 'error', message, hint });
  }
  return connection;
}

/* -------------------------------------------------------------- scanning */

async function runScan(): Promise<{ assets: Asset[]; listMs: number }> {
  if (!session) throw new Error('No device connected.');
  scanAbort?.abort();
  const controller = new AbortController();
  scanAbort = controller;

  const started = Date.now();
  const result = await scanLibrary(session.pool, { signal: controller.signal });
  assets = result.assets;
  assetsById = new Map(assets.map((a) => [a.id, a]));

  send('library:progress', {
    phase: 'listing',
    assetsFound: assets.length,
    metadataDone: 0,
    elapsedMs: result.listMs,
  });

  // Metadata streams in behind the grid; the UI is usable immediately.
  void loadMetadata(session.pool, assets, {
    signal: controller.signal,
    onBatch: (updates) => send('library:metadata', updates),
  })
    .then(() => {
      if (controller.signal.aborted) return;
      send('library:progress', {
        phase: 'done',
        assetsFound: assets.length,
        metadataDone: assets.length,
        elapsedMs: Date.now() - started,
      });
      send('library:stats', summarize(assets));
    })
    .catch(() => undefined);

  return { assets: result.assets, listMs: result.listMs };
}

/* ---------------------------------------------------- Apple USB service */

/** Places the Apple mobile-device daemon is known to live. */
const DAEMON_CANDIDATES = [
  path.join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Common Files\\Apple\\Mobile Device Support\\AppleMobileDeviceProcess.exe',
  ),
  path.join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'DigiDNA\\iMazing\\MobileDevice\\Current\\AppleMobileDeviceProcess.exe',
  ),
];

function findDaemon(): string | null {
  for (const candidate of DAEMON_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ IPC */

function registerIpc(): void {
  ipcMain.handle('device:state', () => connection);
  ipcMain.handle('device:connect', () => connectDevice());
  ipcMain.handle('device:disconnect', async () => {
    await teardownSession();
    setConnection({ status: 'idle' });
  });

  ipcMain.handle('service:probe', async () => {
    try {
      const devices = await listDevices();
      return { reachable: true, deviceCount: devices.length, daemon: findDaemon() };
    } catch (err) {
      return {
        reachable: false,
        deviceCount: 0,
        daemon: findDaemon(),
        message: (err as Error).message,
      };
    }
  });

  ipcMain.handle('service:start', async () => {
    const daemon = findDaemon();
    if (!daemon) return { started: false, message: 'Apple mobile device service was not found.' };
    try {
      spawn(daemon, [], { detached: true, stdio: 'ignore', cwd: path.dirname(daemon) }).unref();
      return { started: true };
    } catch (err) {
      return { started: false, message: (err as Error).message };
    }
  });

  ipcMain.handle('library:scan', () => runScan());
  ipcMain.handle('library:assets', () => assets);

  ipcMain.handle('dialog:chooseFolder', async (_event, current?: string) => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose where to save',
      defaultPath: current || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('paths:pictures', () => app.getPath('pictures'));

  /** Free bytes on whichever volume holds `target`, for the copy dialog. */
  ipcMain.handle('paths:freeSpace', async (_event, target: string) => {
    try {
      const stats = await fs.promises.statfs(path.parse(path.resolve(target)).root);
      return { free: Number(stats.bavail) * Number(stats.bsize) };
    } catch {
      return { free: null };
    }
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_event, value: unknown) => saveSettings(value));

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    if (target) shell.openPath(target);
  });

  ipcMain.handle(
    'transfer:start',
    async (_event, payload: { assetIds: string[]; options: TransferOptions }) => {
      if (!session) throw new Error('No device connected.');

      const selected = payload.assetIds
        .map((id) => assetsById.get(id))
        .filter((a): a is Asset => Boolean(a));
      if (selected.length === 0) throw new Error('Nothing selected.');

      const expanded = expandSelection(selected, assets, payload.options.includeMotion);

      // Sizes are needed for progress; fill any the sweep has not reached.
      const missing = expanded.filter((a) => a.size === 0);
      if (missing.length > 0) {
        await session.pool.map(missing, async (afc, asset) => {
          const info = await afc.stat('/DCIM/' + asset.id);
          asset.size = info.size;
          if (!asset.mtime) asset.mtime = info.birthtime || info.mtime;
        });
      }

      const jobId = 'job-' + Date.now().toString(36);
      const job = new TransferJob(jobId, session.pool, expanded, payload.options);
      jobs.set(jobId, job);

      job.on('progress', (progress) => send('transfer:progress', progress));
      job.on('finished', () => {
        jobs.delete(jobId);
        if (session) {
          send('device:state', { status: 'ready', device: toSummary(session) } as ConnectionState);
        }
      });

      void job.run().catch((err) => {
        jobs.delete(jobId);
        send('transfer:error', { jobId, message: (err as Error).message });
      });

      return { jobId, filesTotal: job.filesTotal, bytesTotal: job.bytesTotal };
    },
  );

  ipcMain.handle('transfer:cancel', (_event, jobId: string) => {
    jobs.get(jobId)?.cancel();
  });

  ipcMain.handle(
    'media:durations',
    async (_event, requests: Array<{ id: string; size: number }>) => {
      if (!durations || !Array.isArray(requests) || requests.length === 0) return {};
      return durations.get(requests.slice(0, 400));
    },
  );

  /**
   * Fetches an original to a temp folder and hands it to the system viewer.
   *
   * The file only exists on the phone, so there is nothing for Explorer to open
   * until it has been pulled across.
   */
  ipcMain.handle('asset:open', async (_event, assetId: string) => {
    if (!session) throw new Error('No device connected.');
    const asset = assetsById.get(assetId);
    if (!asset) throw new Error('Unknown item.');

    // Opened files land in the real destination, not a temp folder: if it was
    // worth pulling across to look at, it is worth keeping — and a later copy
    // then recognises it as already there instead of fetching it twice.
    const settings = loadSettings();
    let dir = settings.destination;
    if (settings.organizeByDate && asset.mtime) {
      const when = new Date(asset.mtime);
      const month = String(when.getMonth() + 1).padStart(2, '0');
      dir = path.join(dir, String(when.getFullYear()), when.getFullYear() + '-' + month);
    }
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch {
      // Destination drive unavailable — fall back so opening still works.
      dir = path.join(app.getPath('temp'), 'ios-transfer-preview');
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const target = path.join(dir, asset.name);

    const info = await session.pool.run((afc) => afc.stat('/DCIM/' + asset.id));

    // Re-use a previous preview when the bytes match.
    try {
      const existing = await fs.promises.stat(target);
      if (existing.size === info.size && info.size > 0) {
        await shell.openPath(target);
        return { path: target, reused: true };
      }
    } catch {
      /* not previewed yet */
    }

    const temp = target + '.part';
    const sink = fs.createWriteStream(temp);
    let done = 0;
    send('preview:progress', { name: asset.name, bytesDone: 0, bytesTotal: info.size });

    try {
      await session.pool.run((afc) =>
        afc.streamFile(
          '/DCIM/' + asset.id,
          async (chunk) => {
            if (!sink.write(chunk)) await once(sink, 'drain');
            done += chunk.length;
            send('preview:progress', {
              name: asset.name,
              bytesDone: done,
              bytesTotal: info.size,
            });
          },
          { chunkSize: 1024 * 1024 },
        ),
      );
      await new Promise<void>((resolve, reject) => {
        sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      await fs.promises.rename(temp, target);
      const captured = info.birthtime || info.mtime || 0;
      if (captured) {
        const when = new Date(captured);
        await fs.promises.utimes(target, when, when).catch(() => undefined);
        // Match what a copy would do, so Explorer sorts it with the rest.
        const times = new CreationTimeWriter(true);
        times.add(target, captured);
        await times.flush();
      }
    } catch (err) {
      sink.destroy();
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      send('preview:progress', { name: asset.name, bytesDone: 0, bytesTotal: 0 });
      throw err;
    }

    send('preview:progress', { name: asset.name, bytesDone: info.size, bytesTotal: info.size });
    const problem = await shell.openPath(target);
    if (problem) throw new Error(problem);
    return { path: target, reused: false };
  });

  /**
   * Deletes originals from the device.
   *
   * Irreversible and guarded in the UI. Note this unlinks the file only — the
   * Photos database still holds the asset, and with iCloud Photos enabled the
   * item may be re-downloaded. The renderer says so before asking to confirm.
   */
  ipcMain.handle('assets:delete', async (_event, assetIds: string[]) => {
    if (!session) throw new Error('No device connected.');
    const targets = assetIds
      .map((id) => assetsById.get(id))
      .filter((a): a is Asset => Boolean(a));
    if (targets.length === 0) return { deleted: 0, failed: 0, errors: [] };

    let deleted = 0;
    const errors: Array<{ name: string; message: string }> = [];

    await session.pool.map(
      targets,
      async (afc, asset) => {
        await afc.removePath('/DCIM/' + asset.id);
        deleted++;
        assetsById.delete(asset.id);
      },
      {
        concurrency: 4,
        onError: (asset, _i, err) =>
          errors.push({ name: asset.name, message: (err as Error).message }),
      },
    );

    // Drop them from the in-memory index so the grid stops showing them.
    const gone = new Set(targets.map((a) => a.id));
    assets = assets.filter((a) => !gone.has(a.id) || errors.some((e) => e.name === a.name));

    return { deleted, failed: errors.length, errors: errors.slice(0, 20) };
  });

  ipcMain.handle('thumbs:prefetch', (_event, ids: Array<{ id: string; isVideo: boolean }>) => {
    thumbnails?.prefetch(ids);
  });
}

/* ------------------------------------------------------------- protocol */

function registerThumbProtocol(): void {
  protocol.handle('thumb', async (request) => {
    const url = new URL(request.url);
    const assetId = decodeURIComponent(url.pathname).replace(/^\//, '');
    const isVideo = url.searchParams.get('v') === '1';

    if (!thumbnails || !assetId) return new Response(null, { status: 404 });

    try {
      const data = await thumbnails.get(assetId, isVideo);
      if (!data) return new Response(null, { status: 404 });
      // A view over the existing buffer — no copy on the way to the renderer.
      // Cast because @types/node's Buffer and the DOM's BodyInit disagree about
      // the ArrayBuffer type parameter; Response accepts a Uint8Array at runtime.
      const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as unknown as BodyInit;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' },
      });
    } catch {
      return new Response(null, { status: 500 });
    }
  });
}

/* ----------------------------------------------------------------- boot */

function createWindow(): void {
  const saved = loadBounds();
  window = new BrowserWindow({
    width: saved?.width ?? 1360,
    height: saved?.height ?? 880,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#12131a',
    title: 'iOS Transfer',
    // Shown immediately: with a hidden title bar 'ready-to-show' does not
    // reliably fire, and the app then runs with no window at all.
    show: true,
    // Windows draws the caption buttons itself so Snap Layouts still work on
    // hover, but they sit inside the app's own header rather than above it.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#191c2b',
      symbolColor: '#c9cee4',
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window?.show());
  // Belt and braces: if the event never arrives, force the window visible.
  setTimeout(() => {
    if (window && !window.isDestroyed() && !window.isVisible()) window.show();
  }, 1500);
  void window.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Dev affordance: render to a PNG so the UI can be inspected without a
  // human at the screen. Set IOS_TRANSFER_CAPTURE to a file path.
  const capturePath = process.env.IOS_TRANSFER_CAPTURE;
  if (capturePath) {
    const delays = (process.env.IOS_TRANSFER_CAPTURE_DELAY ?? '12000')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));

    window.webContents.once('did-finish-load', () => {
      delays.forEach((delay, index) => {
        setTimeout(() => {
          const target =
            delays.length === 1 ? capturePath : capturePath.replace(/\.png$/, '-' + (index + 1) + '.png');
          void window?.webContents
            .capturePage()
            .then((image) => fs.promises.writeFile(target, image.toPNG()))
            .then(() => {
              console.log('captured ' + target);
              if (index === delays.length - 1 && process.env.IOS_TRANSFER_CAPTURE_EXIT === '1') {
                app.quit();
              }
            })
            .catch((err) => console.error('capture failed', err));
        }, delay);
      });
    });
  }
  if (saved?.maximized) window.maximize();

  // Remember the frame, debounced so dragging does not thrash the disk.
  let boundsTimer: NodeJS.Timeout | null = null;
  const rememberBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!window || window.isDestroyed()) return;
      const { width, height, x, y } = window.getNormalBounds();
      saveBounds({ width, height, x, y, maximized: window.isMaximized() });
    }, 400);
  };
  window.on('resize', rememberBounds);
  window.on('move', rememberBounds);
  window.on('maximize', rememberBounds);
  window.on('unmaximize', rememberBounds);

  window.on('closed', () => {
    window = null;
  });
}

app.whenReady().then(() => {
  // No File/Edit/View menu: this app has no menu commands, and the bar only
  // added a second row of chrome above the header.
  Menu.setApplicationMenu(null);

  registerThumbProtocol();
  registerIpc();
  createWindow();

  // Two paths to a connection: usbmuxd's attach events, and a slow poll.
  // The poll covers the case where the service is reachable but has not yet
  // enumerated the cable — common right after the daemon starts.
  const monitor = new DeviceMonitor();
  monitor.on('attach', () => {
    if (!session) void connectDevice();
  });

  const poll = setInterval(() => {
    if (session || connection.status === 'connecting') return;
    void findAttachedDevice()
      .then((record) => {
        if (record && !session) void connectDevice();
      })
      .catch(() => undefined);
  }, 3000);
  app.once('before-quit', () => clearInterval(poll));

  void connectDevice();
  monitor.on('detach', () => {
    void teardownSession().then(() =>
      setConnection({
        status: 'error',
        message: 'iPhone disconnected.',
        hint: 'Reconnect the cable to continue.',
      }),
    );
  });
  monitor.on('error', () => undefined);
  void monitor.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void teardownSession();
  if (process.platform !== 'darwin') app.quit();
});
