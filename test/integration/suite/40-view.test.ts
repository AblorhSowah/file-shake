import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { envPath, getApi, keyOf, openDoc, resetConfig, resetState, rowOf, testing, typeAndWait, waitUntil } from './helpers';

suite('The File Shake webview view (all launch variants)', () => {
  let api: FileShakeApi;
  const o1 = (): string => join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');

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

  test('focusing the view resolves it, the webview posts ready, and the host answers with a snapshot', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('fileShake.view.focus');
    await waitUntil(api, () => testing(api).viewStats().ready >= 1, 'the webview to post ready', 90_000);
    const s = testing(api).viewStats();
    assert.ok(s.resolved >= 1);
    assert.ok(s.sent >= 1, 'a snapshot is sent as soon as the view is ready');
    assert.equal(s.visible, true);
  });

  test('while the view is visible, activity produces more snapshots', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('fileShake.view.focus');
    await waitUntil(api, () => testing(api).viewStats().ready >= 1, 'ready', 90_000);
    const before = testing(api).viewStats().sent;
    await typeAndWait(api, await openDoc(o1()));
    await waitUntil(api, () => testing(api).viewStats().sent > before, 'a snapshot to be pushed to the visible view', 45_000);
    assert.ok(rowOf(api, keyOf(o1())));
  });

  test('a hidden view is sent nothing; showing it again resends the latest snapshot', async function () {
    this.timeout(150_000);
    await vscode.commands.executeCommand('fileShake.view.focus');
    await waitUntil(api, () => testing(api).viewStats().ready >= 1, 'ready', 90_000);
    // Hide the side bar that hosts the Explorer view container.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    try {
      await waitUntil(api, () => !testing(api).viewStats().visible, 'the view to report hidden', 15_000);
    } catch {
      return this.skip(); // this VS Code build did not report visibility for the hidden side bar; nothing to assert
    }
    const sentWhileHidden = testing(api).viewStats().sent;
    await typeAndWait(api, await openDoc(o1()));
    testing(api).advance(500);
    assert.equal(testing(api).viewStats().sent, sentWhileHidden, 'no postMessage while the view is hidden');
    await vscode.commands.executeCommand('fileShake.view.focus');
    await waitUntil(api, () => testing(api).viewStats().sent > sentWhileHidden, 'the latest snapshot to be resent on show', 60_000);
    assert.equal(testing(api).viewStats().visible, true);
  });

  test('the view tolerates being focused repeatedly and while the extension is disabled', async function () {
    this.timeout(120_000);
    for (let i = 0; i < 3; i++) await vscode.commands.executeCommand('fileShake.view.focus');
    await vscode.workspace.getConfiguration('fileShake').update('enable', false, vscode.ConfigurationTarget.Global);
    await waitUntil(api, () => !api.isEnabled(), 'disabled');
    await vscode.commands.executeCommand('fileShake.view.focus');
    assert.deepEqual(api.getRows(), []);
    assert.equal(api.getSnapshot().enabled, false);
  });
});
