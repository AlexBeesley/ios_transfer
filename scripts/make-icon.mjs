/**
 * Generates build/icon.ico.
 *
 * Draws the app mark by hand — a rounded gradient tile with the two-way
 * transfer arrows — so the packaged app does not ship with Electron's default
 * atom icon. Windows accepts PNG-compressed ICO entries, so each size is just a
 * PNG wrapped in an icon directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixels as a PNG. */
function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // colour type: RGBA
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt8(0, 12);

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const SIZES = [256, 128, 64, 48, 32, 16];

/** Smooth 0..1 ramp used for anti-aliasing edges. */
function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance));
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRect(x, y, w, h, r) {
  const dx = Math.abs(x - w / 2) - (w / 2 - r);
  const dy = Math.abs(y - h / 2) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}

/**
 * Signed distance to one arrow: a bar with a triangular head.
 * `dir` is 1 for pointing right, -1 for pointing left.
 */
function arrow(x, y, cy, size, dir) {
  const bar = size * 0.09;
  const left = size * 0.24;
  const right = size * 0.76;
  const headLength = size * 0.15;
  const headHalf = size * 0.15;

  // Shaft, stopping where the head begins.
  const shaftStart = dir > 0 ? left : left + headLength;
  const shaftEnd = dir > 0 ? right - headLength : right;
  const sx = Math.max(shaftStart - x, x - shaftEnd);
  const shaft = Math.max(sx, Math.abs(y - cy) - bar / 2);

  // Head: a triangle narrowing toward the tip.
  const tip = dir > 0 ? right : left;
  const along = (tip - x) * dir; // 0 at the tip, grows backwards
  const head =
    along < 0 || along > headLength
      ? 1e9
      : Math.abs(y - cy) - (headHalf * along) / headLength;

  return Math.min(shaft, head);
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const tileAlpha = coverage(roundedRect(px, py, size, size, radius));
      if (tileAlpha <= 0) continue;

      // Diagonal blue -> violet, matching the in-app brand mark.
      const t = (px / size) * 0.5 + (py / size) * 0.5;
      let r = Math.round(0x4f + (0x8b - 0x4f) * t);
      let g = Math.round(0x8c + (0x5c - 0x8c) * t);
      let b = Math.round(0xff + (0xf6 - 0xff) * t);

      const glyph = Math.max(
        coverage(arrow(px, py, size * 0.4, size, 1)),
        coverage(arrow(px, py, size * 0.6, size, -1)),
      );
      if (glyph > 0) {
        r = Math.round(r + (255 - r) * glyph);
        g = Math.round(g + (255 - g) * glyph);
        b = Math.round(b + (255 - b) * glyph);
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = Math.round(255 * tileAlpha);
    }
  }

  return encodePng(pixels, size);
}

const images = SIZES.map((size) => ({ size, png: render(size) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;

images.forEach((image, index) => {
  const at = index * 16;
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at); // 0 means 256
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
  directory.writeUInt8(0, at + 2); // palette size
  directory.writeUInt8(0, at + 3); // reserved
  directory.writeUInt16LE(1, at + 4); // colour planes
  directory.writeUInt16LE(32, at + 6); // bits per pixel
  directory.writeUInt32LE(image.png.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.png.length;
});

mkdirSync(path.join(root, 'build'), { recursive: true });
const target = path.join(root, 'build', 'icon.ico');
writeFileSync(target, Buffer.concat([header, directory, ...images.map((i) => i.png)]));
console.log('wrote ' + target + ' (' + SIZES.join(', ') + ')');
