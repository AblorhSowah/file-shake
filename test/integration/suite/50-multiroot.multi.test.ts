import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import {
  decorationOf,
  envPath,
  getApi,
  keyOf,
  must,
  openDoc,
  resetConfig,
  resetState,
  rowOf,
  settleRefs,
  testing,
  typeAndWait,
  waitUntil,
} from './helpers';

suite('Multi-root workspace (alpha + beta)', () => {
  let api: FileShakeApi;
  const alpha = (): string => envPath('FS_TEST_ALPHA');
  const beta = (): string => envPath('FS_TEST_BETA');

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await resetState(api);
    testing(api).overrideFocus(true);
  });

  teardown(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
  });

  test('VS Code opened two workspace folders named alpha and beta', () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.deepEqual(folders.map((f) => f.name), ['alpha', 'beta']);
    assert.deepEqual(folders.map((f) => keyOf(f.uri.fsPath)), [keyOf(alpha()), keyOf(beta())]);
  });

  test('the same file name in two roots stays two distinct rows, grouped under their root names', async function () {
    this.timeout(60_000);
    const a = join(alpha(), 'shared.ts');
    const b = join(beta(), 'shared.ts');
    await typeAndWait(api, await openDoc(a));
    testing(api).advance(100);
    await typeAndWait(api, await openDoc(b));
    const ra = must(rowOf(api, keyOf(a)));
    const rb = must(rowOf(api, keyOf(b)));
    assert.notEqual(ra.id, rb.id);
    assert.equal(ra.name, 'shared.ts');
    assert.equal(rb.name, 'shared.ts');
    assert.deepEqual(ra.folderPath, ['alpha']);
    assert.deepEqual(rb.folderPath, ['beta']);
    assert.equal(ra.dir, 'alpha');
    assert.equal(rb.dir, 'beta');
    assert.equal(must(decorationOf(api, a)).badge, '●');
    assert.equal(must(decorationOf(api, b)).badge, '●');
  });

  test('sub folders are prefixed with the root name', async function () {
    this.timeout(60_000);
    const deep = join(alpha(), 'sub', 'deep.ts');
    await typeAndWait(api, await openDoc(deep));
    const row = must(rowOf(api, keyOf(deep)));
    assert.deepEqual(row.folderPath, ['alpha', 'sub']);
    assert.equal(row.dir, 'alpha/sub');
  });

  test('references can point into the other root (../beta/lib from alpha/shared.ts)', async function () {
    this.timeout(60_000);
    const a = join(alpha(), 'shared.ts');
    const lib = join(beta(), 'lib.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(lib)) !== undefined, 'beta/lib.ts to turn yellow');
    const row = must(rowOf(api, keyOf(lib)));
    assert.equal(row.role, 'referenced');
    assert.deepEqual(row.folderPath, ['beta']);
    assert.equal(row.refCount, 2, 'one import + one use of x');
  });

  test('there is a disk watcher for every folder: external writes in either root are seen', async function () {
    this.timeout(90_000);
    const fa = join(alpha(), 'only-alpha.ts');
    const fb = join(beta(), 'lib.ts');
    writeFileSync(fa, 'export const onlyAlpha = 2;\n');
    await waitUntil(api, () => rowOf(api, keyOf(fa))?.source === 'external', 'an external row in alpha', 45_000);
    testing(api).advance(500);
    writeFileSync(fb, 'export const x = 2;\n');
    await waitUntil(api, () => rowOf(api, keyOf(fb))?.source === 'external', 'an external row in beta', 45_000);
    assert.deepEqual(must(rowOf(api, keyOf(fa))).folderPath, ['alpha']);
    assert.deepEqual(must(rowOf(api, keyOf(fb))).folderPath, ['beta']);
  });

  test('exclude globs apply relative to each root', async function () {
    this.timeout(60_000);
    const f = join(beta(), 'node_modules', 'x', 'index.js');
    writeFileSync(join(beta(), 'unused.log'), 'x');
    await waitUntil(api, () => api.getEventLog().some((e) => e.key === keyOf(join(beta(), 'unused.log')) && e.reason === 'excluded'), 'the .log write to be logged as excluded', 45_000);
    assert.equal(rowOf(api, keyOf(join(beta(), 'unused.log'))), undefined);
    assert.equal(rowOf(api, keyOf(f)), undefined);
  });

  test('a file outside every root is shown under "(outside workspace)"', async function () {
    this.timeout(60_000);
    const o1 = join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');
    await typeAndWait(api, await openDoc(o1));
    assert.equal(must(rowOf(api, keyOf(o1))).folderPath[0], '(outside workspace)');
  });
});
