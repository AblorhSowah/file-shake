import { build, context } from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

/** Recursively list *.ts files under a directory (used for integration test entry points). */
function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const common = {
  bundle: true,
  logLevel: 'info',
  minify: production,
  sourcemap: !production,
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [];

if (tests) {
  configs.push({
    ...common,
    entryPoints: listTs(join(root, 'test', 'integration')).filter(
      (f) => !f.endsWith('runTest.ts'),
    ),
    outdir: join(root, 'out', 'integration'),
    outbase: join(root, 'test', 'integration'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'mocha'],
    mainFields: ['module', 'main'],
  });
} else {
  configs.push(
    {
      ...common,
      entryPoints: [join(root, 'src', 'extension.ts')],
      outfile: join(root, 'dist', 'extension.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode'],
      // Mandatory: without 'module' first, esbuild bundles jsonc-parser's UMD build and
      // activation fails at runtime with "Cannot find module './impl/format'".
      mainFields: ['module', 'main'],
    },
    {
      ...common,
      entryPoints: [join(root, 'src', 'webview', 'main.ts')],
      outfile: join(root, 'dist', 'webview.js'),
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
    },
  );
}

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching...');
} else {
  await Promise.all(configs.map((c) => build(c)));
}
