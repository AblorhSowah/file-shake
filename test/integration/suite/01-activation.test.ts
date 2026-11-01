import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { EXT_ID, envPath, getApi, logFor, must, openDoc, resetConfig, resetState, settleRefs, testing, trackedOf, typeAndWait, waitUntil } from './helpers';
import { join } from 'node:path';
import { normalizePath } from '../../../src/core/pathUtils';

suite('Activation and registration (all launch variants)', () => {
  let api: FileShakeApi;

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
    testing(api).overrideFocus(true);
  });

  setup(async function () {
    this.timeout(60_000);
    await resetState(api);
  });

  teardown(async function () {
    this.timeout(60_000);
    await resetConfig();
    await resetState(api);
  });

  test('the extension is installed, active, and exports FileShakeApi v1 with the test seam', () => {
    const ext = must(vscode.extensions.getExtension(EXT_ID), 'extension');
    assert.equal(ext.isActive, true);
    assert.equal(api.apiVersion, 1);
    assert.ok(api.testing, 'FILE_SHAKE_TEST=1 must expose api.testing');
    assert.equal(typeof api.testing?.advance, 'function');
    assert.equal(typeof api.testing?.overrideFocus, 'function');
  });

  test('package.json contributions reached VS Code: view, commands, colours', () => {
    const ext = must(vscode.extensions.getExtension(EXT_ID), 'extension');
    const c = (ext.packageJSON as { contributes: { views: { explorer: Array<{ id: string; type: string }> }; colors: Array<{ id: string }> } }).contributes;
    assert.deepEqual(c.views.explorer.map((v) => `${v.type}:${v.id}`), ['webview:fileShake.view']);
    assert.deepEqual(c.colors.map((x) => x.id).sort(), ['fileShake.editedForeground', 'fileShake.referencedForeground']);
  });

  test('commands (and the auto-generated view focus command) are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['fileShake.toggle', 'fileShake.clear', 'fileShake.focusView', 'fileShake.showDebugInfo', 'fileShake.view.focus']) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  test('the model starts empty and well-formed', () => {
    const snap = api.getSnapshot();
    assert.equal(snap.v, 1);
    assert.equal(snap.enabled, true);
    assert.equal(snap.animate, true);
    assert.deepEqual(snap.colors, { edited: '', referenced: '' });
    assert.deepEqual(snap.rows, []);
    assert.deepEqual(api.getRows(), []);
    assert.deepEqual(api.getTracked(), []);
    assert.equal(api.isEnabled(), true);
    assert.equal(api.getStatusText(), '$(pulse) File Shake');
  });

  test('VS Code serves the documented setting defaults', () => {
    const cfg = vscode.workspace.getConfiguration('fileShake');
    assert.equal(cfg.get('enable'), true);
    assert.equal(cfg.get('enableAnimation'), true);
    assert.equal(cfg.get('idleTimeoutMs'), 2500);
    assert.equal(cfg.get('windowMs'), 3000);
    assert.equal(cfg.get('maxFiles'), 40);
    assert.equal(cfg.get('sensitivity'), 1);
    assert.equal(cfg.get('showWhenIdle'), false);
    assert.equal(cfg.get('decorateFolders'), true);
    assert.equal(cfg.get('detectExternalEdits'), true);
    assert.equal(cfg.get('maxFileSizeKb'), 512);
    assert.equal(cfg.get('showStatusBar'), true);
    assert.equal(cfg.get('colors.edited'), '');
    assert.equal(cfg.get('colors.referenced'), '');
    const globs = cfg.get<string[]>('excludeGlobs') ?? [];
    assert.ok(globs.includes('**/node_modules/**') && globs.includes('**/.git/**'));
  });

  test('merely opening or focusing files is not activity', async () => {
    const outside = envPath('FS_TEST_OUTSIDE');
    for (const f of ['o1.ts', 'o2.ts']) {
      const doc = await openDoc(join(outside, f));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    testing(api).advance(0);
    assert.deepEqual(api.getTracked(), []);
    assert.deepEqual(api.getRows(), []);
    const key = normalizePath(join(outside, 'o1.ts'));
    assert.deepEqual(logFor(api, (e) => e.key === key && e.decision !== 'ignore'), []);
  });

  test('fileShake.focusView resolves the webview view and it posts ready', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('fileShake.focusView');
    await waitUntil(api, () => testing(api).viewStats().resolved >= 1, 'the webview view to be resolved', 60_000);
    await waitUntil(api, () => testing(api).viewStats().ready >= 1, 'the webview to post {type:"ready"}', 60_000);
    const stats = testing(api).viewStats();
    assert.ok(stats.sent >= 1, 'the latest snapshot is sent after the ready handshake');
    assert.equal(stats.visible, true);
  });

  test('fileShake.showDebugInfo writes the documented JSON to the "File Shake" output channel', async function () {
    this.timeout(60_000);
    // put something in the model so the dump has content
    await typeAndWait(api, await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts')));
    await vscode.commands.executeCommand('fileShake.showDebugInfo');
    const readDump = (): Record<string, unknown> | undefined => {
      for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme !== 'output' || !d.uri.toString().includes('file-shake')) continue;
        try {
          const j = JSON.parse(d.getText()) as Record<string, unknown>;
          if ('extensionVersion' in j) return j;
        } catch {
          /* not (yet) a complete JSON document */
        }
      }
      return undefined;
    };
    // the Output channel document appears asynchronously after `show()`
    await waitUntil(api, () => readDump() !== undefined, 'the File Shake output channel to contain the debug JSON', 30_000);
    const dump = must(readDump());
    for (const k of ['extensionVersion', 'vscodeVersion', 'config', 'roots', 'enabled', 'viewVisible', 'seq', 'tracked', 'rows', 'references', 'recentEvents']) {
      assert.ok(k in dump, `debug info lacks ${k}`);
    }
    assert.equal(dump['enabled'], true);
    assert.equal(dump['extensionVersion'], '0.1.0');
    assert.ok(typeof dump['vscodeVersion'] === 'string' && (dump['vscodeVersion'] as string).length > 0);
    const rows = dump['rows'] as Array<{ id: string }>;
    assert.ok(rows.some((r) => r.id === normalizePath(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts'))), 'the dump lists the file being edited');
    const events = dump['recentEvents'] as Array<{ reason: string }>;
    assert.ok(Array.isArray(events) && events.length > 0 && events.length <= 50, 'recentEvents is the bounded ring buffer');
    const cfg = dump['config'] as Record<string, unknown>;
    assert.equal(cfg['idleTimeoutMs'], 2500);
    assert.ok(Array.isArray(cfg['excludeGlobs']));
  });

  test('fileShake.toggle flips fileShake.enable and the model follows, in both directions', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('fileShake.toggle');
    await waitUntil(api, () => !api.isEnabled(), 'the extension to report disabled');
    assert.equal(api.getSnapshot().enabled, false);
    assert.equal(api.getStatusText(), '$(circle-slash) File Shake: off');
    assert.deepEqual(api.getRows(), []);
    await vscode.commands.executeCommand('fileShake.toggle');
    await waitUntil(api, () => api.isEnabled(), 'the extension to report enabled again');
    assert.equal(api.getSnapshot().enabled, true);
    assert.equal(api.getStatusText(), '$(pulse) File Shake');
  });

  test('fileShake.clear is safe on an empty model', async () => {
    await vscode.commands.executeCommand('fileShake.clear');
    assert.deepEqual(api.getRows(), []);
  });

  test('nothing is tracked for a file that was never edited, even after the fake clock runs', () => {
    testing(api).advance(10_000);
    assert.equal(trackedOf(api, normalizePath(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts'))), undefined);
  });

  test('zero timers when idle: nothing is scheduled after activation, and the tick chain stops once everything has expired', async function () {
    this.timeout(60_000);
    await resetState(api);
    testing(api).advance(120_000);
    assert.equal(testing(api).pendingTimers(), 0, 'idle means no timers at all');
    // activity starts the chain (tick, reference debounce) ...
    const doc = await openDoc(join(envPath('FS_TEST_OUTSIDE'), 'o1.ts'));
    await typeAndWait(api, doc);
    assert.ok(testing(api).pendingTimers() >= 1, 'a tick and a reference debounce are pending while a file is active');
    // ... and it winds down by itself: idle after 2500 ms, removed after 6500 ms, nothing left behind
    await settleRefs(api);
    testing(api).advance(10_000);
    assert.deepEqual(api.getRows(), []);
    assert.equal(testing(api).pendingTimers(), 0, 'the self-stopping tick chain left no timer behind');
  });
});
