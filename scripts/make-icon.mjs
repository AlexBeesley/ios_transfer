/**
 * Packs icons/*.png into build/icon.ico for the Windows .exe.
 * Source art is the uSeeMore photo-grid mark (PNG sizes in icons/).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [256, 128, 48, 32, 16];

const images = SIZES.map((size) => {
  const png = readFileSync(path.join(root, 'icons', `icon${size}.png`));
  return { size, png };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;

images.forEach((image, index) => {
  const at = index * 16;
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at);
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
  directory.writeUInt8(0, at + 2);
  directory.writeUInt8(0, at + 3);
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(image.png.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.png.length;
});

mkdirSync(path.join(root, 'build'), { recursive: true });
const target = path.join(root, 'build', 'icon.ico');
writeFileSync(target, Buffer.concat([header, directory, ...images.map((i) => i.png)]));
console.log('wrote ' + target + ' from uSeeMore grid icon (' + SIZES.join(', ') + ')');
