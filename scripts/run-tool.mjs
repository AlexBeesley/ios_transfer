/**
 * Runs a bundled tool inside Electron's Node runtime.
 *
 * The device layer needs Electron's exact Node/TLS build, and setting an env
 * var inline is not portable across shells, so it is set here instead.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const script = process.argv[2];
if (!script) {
  console.error('usage: node scripts/run-tool.mjs <script.js> [args…]');
  process.exit(1);
}

const child = spawn(electron, [path.join(root, script), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('exit', (code) => process.exit(code ?? 1));
