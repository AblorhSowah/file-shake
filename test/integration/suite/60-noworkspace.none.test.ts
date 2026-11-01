import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { colorIdOf, decorationOf, envPath, getApi, keyOf, logFor, must, openDoc, resetConfig, resetState, rowOf, setConfig, settleRefs, testing, typeAndWait, waitUntil } from './helpers';

suite('No folder open', () => {
  let api: FileShakeApi;
  const o1 = (): string => join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');
  const o2 = (): string => join(envPath('FS_TEST_OUTSIDE'), 'o2.ts');

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

  test('VS Code really has no workspace folder', () => {
    assert.ok(!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0);
  });

  test('activation worked and the model is empty', () => {
    assert.equal(api.apiVersion, 1);
    assert.deepEqual(api.getRows(), []);
    assert.equal(api.getStatusText(), '$(pulse) File Shake');
  });

  test('typing in a loose file is tracked: green row grouped under "(outside workspace)"', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(o1()));
    const row = must(rowOf(api, keyOf(o1())));
    assert.equal(row.role, 'edited');
    assert.equal(row.source, 'you');
    assert.equal(row.folderPath[0], '(outside workspace)');
    assert.equal(row.dir, keyOf(envPath('FS_TEST_OUTSIDE')));
    const d = must(decorationOf(api, o1()));
    assert.equal(d.badge, '●');
    assert.equal(colorIdOf(d), 'fileShake.editedForeground');
    assert.equal(api.getStatusText(), '$(pulse) o1.ts · typing');
  });

  test('references resolve next to a loose file (roots = [its directory])', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(o1()));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(o2())) !== undefined, 'o2.ts to turn yellow');
    const row = must(rowOf(api, keyOf(o2())));
    assert.equal(row.role, 'referenced');
    assert.equal(row.refCount, 2, 'one import statement + one use of o2');
    assert.equal(must(decorationOf(api, o2())).badge, '2');
  });

  test('the exclude globs use the absolute path without its leading slash for loose files', async function () {
    this.timeout(60_000);
    const f = join(envPath('FS_TEST_OUTSIDE'), 'node_modules', 'x', 'index.js');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(envPath('FS_TEST_OUTSIDE'), 'node_modules', 'x'), { recursive: true });
    writeFileSync(f, 'module.exports = 1;\n');
    await vscode.window.showTextDocument(await openDoc(f), { preview: false });
    const editor = must(vscode.window.activeTextEditor, 'active editor');
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), ' '));
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.reason === 'excluded').length >= 1, 'an excluded log entry');
    assert.equal(rowOf(api, keyOf(f)), undefined);
  });

  test('commands work without a workspace', async () => {
    await typeAndWait(api, await openDoc(o1()));
    await vscode.commands.executeCommand('fileShake.clear');
    assert.deepEqual(api.getRows(), []);
    await vscode.commands.executeCommand('fileShake.showDebugInfo');
    await vscode.commands.executeCommand('fileShake.focusView');
  });

  test('idle clean-up works without a workspace', async function () {
    this.timeout(60_000);
    await setConfig('persistUntilNextFile', false); // this test is about timed removal, which persistence replaces
    await typeAndWait(api, await openDoc(o1()));
    testing(api).advance(2500);
    assert.equal(must(rowOf(api, keyOf(o1()))).phase, 'idle');
    testing(api).advance(4000);
    assert.deepEqual(api.getRows(), []);
  });
});
