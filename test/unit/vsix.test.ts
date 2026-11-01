// Package audit of the built file-shake-0.1.0.vsix (produced by `npm run package`; run it first, ideally from a clean dist/).
// The .vsix is unzipped with the system `unzip`; nothing is installed or executed except a stub-`vscode` load of the bundle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO_ROOT, readRepoFile } from '../support/fixtures';

const vsixPath = join(REPO_ROOT, 'file-shake-0.1.0.vsix');
const have = existsSync(vsixPath);
const SKIP = 'file-shake-0.1.0.vsix is missing: run `npm run package` first';

function unzipList(): string[] {
  const r = spawnSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).sort();
}

function unzipFile(name: string): Buffer {
  const r = spawnSync('unzip', ['-p', vsixPath, name], { maxBuffer: 20 * 1024 * 1024 });
  assert.equal(r.status, 0, `could not extract ${name}: ${r.stderr.toString()}`);
  return r.stdout;
}

const EXPECTED = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/changelog.md',
  'extension/dist/extension.js',
  'extension/dist/webview.js',
  'extension/media/icon.png',
  'extension/media/webview.css',
  'extension/package.json',
  'extension/readme.md',
].sort();

describe('.vsix package audit', () => {
  it('contains exactly the expected 10 files, nothing else', (t) => {
    if (!have) return t.skip(SKIP);
    assert.deepEqual(unzipList(), EXPECTED);
  });

  it('is smaller than 150 KB', (t) => {
    if (!have) return t.skip(SKIP);
    assert.ok(statSync(vsixPath).size < 150 * 1024, `${statSync(vsixPath).size} bytes`);
  });

  it('ships no source maps, sources, tests, node_modules, docs or dotfiles', (t) => {
    if (!have) return t.skip(SKIP);
    for (const f of unzipList()) {
      assert.ok(!/\.map$/.test(f), f);
      assert.ok(!/(^|\/)(src|test|node_modules|docs|scripts|out|\.vscode-test|\.claude)(\/|$)/.test(f), f);
      assert.ok(!/(^|\/)\.[^/]+/.test(f), `dotfile ${f}`);
      assert.ok(!/\.(ts|mjs|tsbuildinfo|vsix)$/.test(f), f);
    }
  });

  it('the packaged bundles carry no sourceMappingURL', (t) => {
    if (!have) return t.skip(SKIP);
    for (const f of ['extension/dist/extension.js', 'extension/dist/webview.js', 'extension/media/webview.css']) {
      assert.ok(!unzipFile(f).toString('utf8').includes('sourceMappingURL'), f);
    }
  });

  it('the packaged package.json is the repository manifest', (t) => {
    if (!have) return t.skip(SKIP);
    const packaged = JSON.parse(unzipFile('extension/package.json').toString('utf8')) as Record<string, unknown>;
    const repo = JSON.parse(readRepoFile('package.json')) as Record<string, unknown>;
    for (const k of ['name', 'displayName', 'version', 'publisher', 'engines', 'main', 'activationEvents', 'extensionKind', 'contributes', 'icon', 'galleryBanner', 'categories', 'license', 'capabilities']) {
      assert.deepEqual(packaged[k], repo[k], k);
    }
  });

  it('vsixmanifest: identity, engine, extension kind, banner, license and icon', (t) => {
    if (!have) return t.skip(SKIP);
    const m = unzipFile('extension.vsixmanifest').toString('utf8');
    assert.match(m, /<Identity Language="en-US" Id="file-shake" Version="0\.1\.0" Publisher="file-shake" \/>/);
    assert.match(m, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.85\.0"/);
    assert.match(m, /Microsoft\.VisualStudio\.Code\.ExtensionKind" Value="workspace"/);
    assert.match(m, /Branding\.Color" Value="#0d1117"/);
    assert.match(m, /Branding\.Theme" Value="dark"/);
    assert.match(m, /<License>extension\/LICENSE\.txt<\/License>/);
    assert.match(m, /<Icon>extension\/media\/icon\.png<\/Icon>/);
    assert.match(m, /<DisplayName>File Shake<\/DisplayName>/);
  });

  it('the packaged icon is a 128x128 RGBA PNG (header check)', (t) => {
    if (!have) return t.skip(SKIP);
    const png = unzipFile('extension/media/icon.png');
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(png[25], 6, 'colour type RGBA');
  });

  it('LICENSE.txt is the MIT text; changelog and readme are present and non-trivial', (t) => {
    if (!have) return t.skip(SKIP);
    assert.match(unzipFile('extension/LICENSE.txt').toString('utf8'), /MIT License[\s\S]*Copyright \(c\) 2026 File Shake contributors/);
    assert.ok(unzipFile('extension/readme.md').length > 3000);
    assert.match(unzipFile('extension/changelog.md').toString('utf8'), /0\.1\.0/);
  });

  it('extension.js requires only "vscode" and Node built-ins (nothing that is not in the .vsix)', (t) => {
    if (!have) return t.skip(SKIP);
    const code = unzipFile('extension/dist/extension.js').toString('utf8');
    const specs = new Set<string>();
    for (const m of code.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)) specs.add(m[2] as string);
    assert.ok(specs.has('vscode'));
    const builtins = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
    const foreign = [...specs].filter((s) => s !== 'vscode' && !builtins.has(s));
    assert.deepEqual(foreign, [], 'every other dependency must be bundled');
    // no dynamic/indirect require of an unknown module either
    assert.ok(!/\brequire\(\s*[A-Za-z_$]/.test(code), 'no require() of a variable');
    assert.ok(!/\bimport\(\s*[A-Za-z_$"'`]/.test(code), 'no dynamic import');
  });

  it('extension.js loads under Node with a stub `vscode` and exports activate/deactivate (catches missing bundled modules, e.g. the jsonc-parser UMD trap)', (t) => {
    if (!have) return t.skip(SKIP);
    const code = unzipFile('extension/dist/extension.js').toString('utf8');
    const realRequire = createRequire(join(REPO_ROOT, 'package.json'));
    const stub: object = new Proxy(function stubTarget() {}, {
      get: (_t, prop) => (prop === 'then' ? undefined : prop === '__esModule' ? false : stub),
      construct: () => ({}) as object,
      apply: () => stub,
    });
    const mod = { exports: {} as Record<string, unknown> };
    const sandboxRequire = (id: string): unknown => {
      if (id === 'vscode') return stub;
      if (id.startsWith('.') || id.startsWith('/')) throw new Error(`the bundle must not require files: ${id}`);
      return realRequire(id);
    };
    const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: 'extension.js' }) as (...a: unknown[]) => void;
    wrapper(mod.exports, sandboxRequire, mod, 'extension.js', '.');
    assert.equal(typeof mod.exports['activate'], 'function');
    assert.equal(typeof mod.exports['deactivate'], 'function');
  });

  it('webview.js is a self-contained browser script: no require, import, node globals or vscode', (t) => {
    if (!have) return t.skip(SKIP);
    const code = unzipFile('extension/dist/webview.js').toString('utf8');
    assert.ok(!/\brequire\(|\bimport\(|\bprocess\.|\bBuffer\b|__dirname|from"vscode"/.test(code));
    assert.ok(code.includes('acquireVsCodeApi'));
  });

  it('the packaged CSS has no remote URLs', (t) => {
    if (!have) return t.skip(SKIP);
    assert.ok(!/https?:\/\//.test(unzipFile('extension/media/webview.css').toString('utf8')));
  });
});
