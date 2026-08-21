/**
 * UI harness: runs the real renderer against synthetic data.
 *
 * Serves the thumb:// scheme from generated bitmaps so the image pipeline
 * (custom protocol, CSP, <img> wiring, virtualization) can be verified with no
 * device attached.
 */
import { app, BrowserWindow, nativeImage, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

/** Deterministic colour per asset id so the grid is visibly varied. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function swatch(id: string): Buffer {
  const width = 48;
  const height = 64;
  const seed = hash(id);
  const r = 40 + (seed % 150);
  const g = 40 + ((seed >> 8) % 150);
  const b = 60 + ((seed >> 16) % 150);

  // Electron's bitmap format is BGRA, premultiplied.
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const shade = 1 - (y / height) * 0.45;
      pixels[offset] = Math.round(b * shade);
      pixels[offset + 1] = Math.round(g * shade);
      pixels[offset + 2] = Math.round(r * shade);
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
}

app.whenReady().then(() => {
  protocol.handle('thumb', (request) => {
    const assetId = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, '');
    if (!assetId) return new Response(null, { status: 404 });
    const png = swatch(assetId);
    const body = new Uint8Array(png.buffer, png.byteOffset, png.byteLength) as unknown as BodyInit;
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
  });

  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    backgroundColor: '#12131a',
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#191c2b', symbolColor: '#c9cee4', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log('[renderer:' + level + '] ' + message + '  (' + source + ':' + line + ')');
  });
  window.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer gone] ' + JSON.stringify(details));
  });

  window.once('ready-to-show', () => window.show());
  void window.loadFile(path.join(__dirname, '../renderer/index.html'));

  const target = process.env.IOS_TRANSFER_CAPTURE ?? 'uitest.png';
  // Optional scripted interaction so selection and modal states can be captured.
  const interact = async (): Promise<void> => {
    if (process.env.IOS_TRANSFER_INTERACT !== '1') return;
    await window.webContents.executeJavaScript(`
      (() => {
        const tiles = [...document.querySelectorAll('.tile')];
        for (const i of [0, 1, 2, 6, 7, 8, 13]) {
          tiles[i]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        }
        return true;
      })();
    `);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await window.webContents.executeJavaScript(`
      document.querySelector('footer .btn.primary')?.click(); true;
    `);
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void interact()
        .then(() => window.webContents.capturePage())
        .then((image) => fs.promises.writeFile(target, image.toPNG()))
        .then(() => {
          console.log('captured ' + target);
          app.quit();
        })
        .catch((err) => {
          console.error('capture failed', err);
          app.quit();
        });
    }, Number(process.env.IOS_TRANSFER_CAPTURE_DELAY ?? 3000));
  });
});
