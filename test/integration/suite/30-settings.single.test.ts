import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { K } from '../../../src/core/constants';
import {
  decorationOf,
  getApi,
  keyOf,
  logFor,
  must,
  openDoc,
  removePath,
  resetConfig,
  resetState,
  rowOf,
  scratchDir,
  setConfig,
  settleRefs,
  testing,
  trackedOf,
  typeAndWait,
  typeInto,
  waitUntil,
  workspaceDir,
  writeFile,
} from './helpers';

suite('Settings apply live (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const created: string[] = [];

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
    testing(api).overrideFocus(true);
  });

  teardown(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
    for (const d of created.splice(0)) removePath(d);
  });

  test('enableAnimation=false is reflected in the snapshot (animate:false) and back', async function () {
    this.timeout(60_000);
    await setConfig('enableAnimation', false);
    await waitUntil(api, () => api.getSnapshot().animate === false, 'animate=false');
    await setConfig('enableAnimation', true);
    await waitUntil(api, () => api.getSnapshot().animate === true, 'animate=true');
  });

  test('colours: valid hex values reach the snapshot, invalid ones are sanitised to "" (follow theme)', async function () {
    this.timeout(60_000);
    await setConfig('colors.edited', '#ff0000');
    await setConfig('colors.referenced', '#00ff0080');
    await waitUntil(api, () => api.getSnapshot().colors.edited === '#ff0000' && api.getSnapshot().colors.referenced === '#00ff0080', 'custom colours');
    await setConfig('colors.edited', 'not-a-colour');
    await waitUntil(api, () => api.getSnapshot().colors.edited === '', 'invalid colour sanitised');
    assert.equal(api.getSnapshot().colors.referenced, '#00ff0080');
  });

  test('enable=false clears state, ignores later edits (reason "disabled") and re-enabling works again', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    const doc = await openDoc(a);
    await typeAndWait(api, doc);
    assert.ok(rowOf(api, keyOf(a)));
    await setConfig('enable', false);
    await waitUntil(api, () => !api.isEnabled(), 'disabled');
    assert.deepEqual(api.getRows(), []);
    assert.deepEqual(api.getTracked(), []);
    assert.equal(decorationOf(api, a), undefined);
    assert.equal(api.getSnapshot().enabled, false);
    await typeInto(doc, 'x');
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(a) && e.reason === 'disabled').length >= 1, 'a "disabled" log entry');
    assert.deepEqual(api.getTracked(), []);
    await setConfig('enable', true);
    await waitUntil(api, () => api.isEnabled(), 'enabled');
    await typeAndWait(api, doc);
    assert.ok(rowOf(api, keyOf(a)));
  });

  test('idleTimeoutMs is re-applied without a restart', async function () {
    this.timeout(60_000);
    await setConfig('idleTimeoutMs', 500);
    await waitUntil(api, () => vscode.workspace.getConfiguration('fileShake').get('idleTimeoutMs') === 500, 'config value');
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    testing(api).advance(499);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'active');
    testing(api).advance(1);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'idle');
  });

  test('out-of-range values are clamped: idleTimeoutMs=1 behaves like the 500 ms minimum', async function () {
    this.timeout(60_000);
    await setConfig('idleTimeoutMs', 1);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    testing(api).advance(499);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'active');
    testing(api).advance(1);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'idle');
  });

  test('sensitivity changes the intensity of the same activity', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    const base = await typeAndWait(api, await openDoc(a));
    await setConfig('sensitivity', 4);
    await waitUntil(api, () => (trackedOf(api, keyOf(a))?.intensity ?? 0) > base.intensity + 0.1, 'a higher intensity at sensitivity 4');
    await setConfig('sensitivity', 0.25);
    await waitUntil(api, () => (trackedOf(api, keyOf(a))?.intensity ?? 1) < base.intensity - 0.05 || (trackedOf(api, keyOf(a))?.intensity ?? 1) <= K.FLOOR + 1e-9, 'a lower intensity at sensitivity 0.25');
  });

  test('showWhenIdle=true keeps idle rows (and their decorations) past the retain window', async function () {
    this.timeout(60_000);
    await setConfig('persistUntilNextFile', false); // this test is about timed removal, which persistence replaces
    await setConfig('showWhenIdle', true);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    testing(api).advance(K.RETAIN_AFTER_IDLE_MS + 60_000);
    const row = must(rowOf(api, keyOf(a)));
    assert.equal(row.phase, 'idle');
    assert.equal(row.intensity, 0);
    assert.ok(decorationOf(api, a), 'idle rows are decorated when showWhenIdle is on');
    const b = must(rowOf(api, keyOf(join(ws, 'b.ts'))), 'references of an idle source are shown with showWhenIdle');
    assert.equal(b.phase, 'idle');
    assert.equal(b.intensity, 0);
    await setConfig('showWhenIdle', false);
    await waitUntil(api, () => rowOf(api, keyOf(a)) === undefined, 'idle rows to be dropped once showWhenIdle is off');
  });

  test('decorateFolders=false turns off propagation to parent folders', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    assert.equal(must(decorationOf(api, a)).propagate, true);
    await setConfig('decorateFolders', false);
    await waitUntil(api, () => decorationOf(api, a)?.propagate === false, 'propagate=false');
  });

  test('detectExternalEdits=false ignores disk changes (reason "external-detection-off")', async function () {
    this.timeout(60_000);
    await setConfig('detectExternalEdits', false);
    const dir = scratchDir(ws, 'noext');
    created.push(dir);
    const f = writeFile(dir, 'quiet.ts', 'export {};\n');
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.reason === 'external-detection-off').length >= 1, 'an "external-detection-off" log entry', 45_000);
    assert.equal(trackedOf(api, keyOf(f)), undefined);
    // typing is unaffected
    await typeAndWait(api, await openDoc(join(ws, 'a.ts')));
    assert.ok(rowOf(api, keyOf(join(ws, 'a.ts'))));
  });

  test('excludeGlobs is applied live: a new pattern excludes, [] allows node_modules', async function () {
    this.timeout(60_000);
    await setConfig('excludeGlobs', ['**/a.ts']);
    const a = join(ws, 'a.ts');
    await typeInto(await openDoc(a));
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(a) && e.reason === 'excluded').length >= 1, 'a.ts to be excluded');
    assert.equal(trackedOf(api, keyOf(a)), undefined);

    await setConfig('excludeGlobs', []);
    const nm = join(ws, 'node_modules', 'pkg', 'index.js');
    await typeAndWait(api, await openDoc(nm));
    assert.ok(rowOf(api, keyOf(nm)), 'with an empty list nothing is excluded');
  });

  test('maxFiles trims the rows (edited first)', async function () {
    this.timeout(90_000);
    await setConfig('maxFiles', 5);
    await waitUntil(api, () => vscode.workspace.getConfiguration('fileShake').get('maxFiles') === 5, 'maxFiles=5');
    const dir = scratchDir(ws, 'many');
    created.push(dir);
    for (let i = 0; i < 8; i++) {
      const f = writeFile(dir, `m${i}.ts`, 'export {};\n');
      await waitUntil(api, () => trackedOf(api, keyOf(f)) !== undefined, `tracked m${i}.ts`, 45_000);
      testing(api).advance(50);
    }
    assert.ok(api.getTracked().length <= 5, `tracker kept ${api.getTracked().length}`);
    assert.ok(api.getRows().length <= 5, `rows: ${api.getRows().length}`);
  });

  test('invalid values for numeric settings never break the extension', async function () {
    this.timeout(60_000);
    await setConfig('idleTimeoutMs', 'soon');
    await setConfig('windowMs', -5);
    await setConfig('maxFiles', 1e9);
    await setConfig('sensitivity', 'high');
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    const row = must(rowOf(api, keyOf(a)));
    assert.ok(row.intensity > 0 && row.intensity <= 1);
  });

  test('toggling several settings quickly leaves a consistent model', async function () {
    this.timeout(60_000);
    await Promise.all([setConfig('enableAnimation', false), setConfig('showWhenIdle', true), setConfig('decorateFolders', false), setConfig('colors.edited', '#123456')]);
    await waitUntil(api, () => api.getSnapshot().animate === false && api.getSnapshot().colors.edited === '#123456', 'all changes applied');
    assert.equal(api.isEnabled(), true);
  });
});
