import { build, context } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const withTools = process.argv.includes('--tools');
const dev = watch || process.argv.includes('--dev');

/** Electron's own runtime supplies these; never bundle them. */
const electronExternals = ['electron', 'node:*', ...['fs', 'path', 'net', 'tls', 'os', 'crypto',
  'stream', 'events', 'child_process', 'worker_threads', 'url', 'util', 'zlib', 'http', 'https'],
];

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

const targets = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: electronExternals,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.js'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: electronExternals,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/renderer/main.tsx')],
    outfile: path.join(root, 'dist/renderer/main.js'),
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  },
];

if (withTools) {
  // Diagnostics and the offline UI harness — not part of the shipped app.
  targets.push(
    {
      ...common,
      minify: false,
      entryPoints: [path.join(root, 'src/doctor.ts'), path.join(root, 'src/e2e.ts')],
      outdir: path.join(root, 'dist/tools'),
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      external: electronExternals,
    },
    {
      ...common,
      minify: false,
      entryPoints: [path.join(root, 'src/uitest/main.ts'), path.join(root, 'src/uitest/preload.ts')],
      outdir: path.join(root, 'dist/uitest'),
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      external: electronExternals,
    },
  );
}

function copyStatic() {
  mkdirSync(path.join(root, 'dist/renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    const from = path.join(root, 'src/renderer', file);
    if (existsSync(from)) copyFileSync(from, path.join(root, 'dist/renderer', file));
  }

  const fontsFrom = path.join(root, 'src/renderer/fonts');
  if (existsSync(fontsFrom)) {
    const fontsTo = path.join(root, 'dist/renderer/fonts');
    mkdirSync(fontsTo, { recursive: true });
    for (const file of readdirSync(fontsFrom)) {
      copyFileSync(path.join(fontsFrom, file), path.join(fontsTo, file));
    }
  }
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  copyStatic();
  console.log('watching for changes...');
} else {
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  console.log('build complete');
}
