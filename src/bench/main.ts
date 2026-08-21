/** Benchmark harness: measures CLIP encode throughput on cached thumbnails. */
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'model',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

const MODELS = path.join(__dirname, '../../models');
const ORT = path.join(__dirname, '../../node_modules/onnxruntime-web/dist');

function contentType(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.js')) return 'text/javascript';
  return 'application/octet-stream';
}

app.whenReady().then(async () => {
  protocol.handle('model', async (request) => {
    const url = new URL(request.url);
    const root = url.hostname === 'ort' ? ORT : MODELS;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root)) return new Response(null, { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as unknown as BodyInit;
      return new Response(body, { status: 200, headers: { 'content-type': contentType(file) } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  ipcMain.handle('thumbs', async (_e, count: number) => {
    const root = path.join(app.getPath('appData'), 'ios-transfer', 'thumbnails');
    const out: ArrayBuffer[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= count) return;
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (out.length >= count) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.jpg')) {
          const b = await fs.promises.readFile(full);
          out.push(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        }
      }
    };
    await walk(root).catch(() => undefined);
    return out;
  });

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(message);
    if (message.startsWith('BENCH DONE')) app.quit();
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
});
