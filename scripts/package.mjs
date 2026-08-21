/**
 * Packages the app into a standalone Windows folder with its own .exe.
 *
 * Everything the app runs is already bundled into dist/ by esbuild, so the
 * sources, dev tooling and node_modules are all left out.
 */
import { packager } from '@electron/packager';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');

/** Paths kept out of the package, matched against app-relative paths. */
const IGNORE = [
  /^\/src($|\/)/,
  /^\/scripts($|\/)/,
  /^\/release($|\/)/,
  /^\/build($|\/)/,
  /^\/node_modules($|\/)/,
  /^\/dist\/(tools|uitest|probe)($|\/)/,
  /^\/\.git($|\/)/,
  /^\/tsconfig\.json$/,
  /^\/package-lock\.json$/,
  /^\/README\.md$/,
];

/** The output folder cannot be replaced while the packaged app is running. */
function bail(err) {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
    console.error(
      '\nCannot replace release/ — the packaged app is still running.\n' +
        'Close "iOS Transfer", then run this again.\n' +
        '(npm start runs the latest code without packaging.)\n',
    );
    process.exit(1);
  }
  throw err;
}

try {
  rmSync(out, { recursive: true, force: true });
} catch (err) {
  bail(err);
}

const paths = await packager({
  dir: root,
  out,
  name: 'iOS Transfer',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'build', 'icon.ico'),
  asar: true,
  overwrite: true,
  prune: true,
  ignore: IGNORE,
  appVersion: '1.0.0',
  win32metadata: {
    CompanyName: 'iOS Transfer',
    FileDescription: 'Fast iPhone photo and video transfer',
    ProductName: 'iOS Transfer',
    InternalName: 'iOS Transfer',
  },
});

for (const created of paths) {
  console.log('packaged -> ' + path.join(created, 'iOS Transfer.exe'));
}

process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
