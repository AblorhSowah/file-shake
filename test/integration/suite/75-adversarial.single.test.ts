// Adversarial probes found by reading src/vscode/**. A test titled [QA-nnn] reproduces a defect filed in
// docs/QA_REPORT.md and FAILS until the Builder fixes it; the others pin behaviour that could plausibly regress.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import {
  createSettled,
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
  runNode,
  scratchDir,
  setConfig,
  settleRefs,
  testing,
  trackedOf,
  typeAndWait,
  waitUntil,
  waitUntilAdvancing,
  workspaceDir,
  writeFile,
} from './helpers';

suite('Adversarial probes (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const created: string[] = [];
  const touchedSettings: Array<[string, unknown]> = [];

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
    for (const [key, value] of touchedSettings.splice(0)) await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
    await resetConfig();
    await resetState(api);
    for (const d of created.splice(0)) removePath(d);
  });

  const scratch = (label: string): string => {
    const d = scratchDir(ws, label);
    created.push(d);
    return d;
  };

  /** Latest fake-clock stamp in the (shared, bounded) event log for `key`; entries added later have a larger stamp once time advanced. */
  const stampOf = (key: string): number => logFor(api, (e) => e.key === key).reduce((m, e) => Math.max(m, e.at), -Infinity);

  async function insertAtStart(doc: vscode.TextDocument, text: string): Promise<void> {
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const before = trackedOf(api, keyOf(doc.uri.fsPath))?.editCount ?? 0;
    assert.equal(await editor.edit((b) => b.insert(new vscode.Position(0, 0), text)), true);
    await waitUntil(api, () => (trackedOf(api, keyOf(doc.uri.fsPath))?.editCount ?? 0) > before, 'the edit to be recorded');
  }

  test('[QA-002] closing a document without saving and re-opening it must not reuse the previous session\'s reference result (document versions restart at 1)', async function () {
    this.timeout(90_000);
    const dir = scratch('versions');
    const made = await createSettled(api, dir, { 'b1.ts': 'export {};\n', 'c1.ts': 'export {};\n', 'ver.ts': 'export {};\n' });
    const ver = must(made['ver.ts']);
    const b1 = keyOf(must(made['b1.ts']));
    const c1 = keyOf(must(made['c1.ts']));

    // session 1: the document imports b1 (document version 2)
    const doc1 = await openDoc(ver);
    await insertAtStart(doc1, "import './b1';\n");
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, b1)?.role === 'referenced', 'b1 to be referenced in session 1', 45_000);

    // close WITHOUT saving: the buffer is discarded
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    // VS Code keeps the text model alive for a while after the editor closes; only when it is really disposed does the next
    // open start again at version 1 (the precondition of this defect). If the model survives, the defect is not reproducible here.
    try {
      await waitUntil(api, () => !vscode.workspace.textDocuments.some((d) => d.uri.fsPath === ver), 'the document to be closed', 8_000);
    } catch {
      return this.skip();
    }

    // session 2: a brand-new document object (version 1) imports c1 instead (version 2 again)
    const doc2 = await openDoc(ver);
    if (doc2.version !== 1) return this.skip(); // precondition of the scenario: a fresh document starts at version 1
    await insertAtStart(doc2, "import './c1';\n");
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, c1)?.role === 'referenced' || rowOf(api, b1)?.role === 'referenced', 'some reference row', 45_000);
    assert.equal(rowOf(api, c1)?.role, 'referenced', 'the file now imports c1');
    assert.equal(rowOf(api, b1), undefined, 'the file no longer imports b1: that result belongs to the discarded buffer');
  });

  test('[QA-003] with showWhenIdle on, renaming an UNRELATED file must not wipe the references of idle files', async function () {
    this.timeout(90_000);
    const dir = scratch('idle-refs');
    const made = await createSettled(api, dir, { 'u.ts': 'export {};\n', 'dep.ts': 'export const d = 1;\n', 'src.ts': "import { d } from './dep';\nd();\n" });
    await setConfig('showWhenIdle', true);
    const src = must(made['src.ts']);
    const dep = keyOf(must(made['dep.ts']));
    await typeAndWait(api, await openDoc(src));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, dep)?.role === 'referenced', 'dep to be referenced', 45_000);
    testing(api).advance(3000); // src is idle now, but showWhenIdle keeps it and its references
    assert.equal(rowOf(api, keyOf(src))?.phase, 'idle');
    assert.equal(rowOf(api, dep)?.phase, 'idle', 'precondition: the idle reference is still listed');

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(must(made['u.ts'])), vscode.Uri.file(join(dir, 'u2.ts')));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitUntil(api, () => trackedOf(api, keyOf(join(dir, 'u2.ts'))) !== undefined, 'the rename to be seen', 45_000);
    await settleRefs(api);
    assert.equal(rowOf(api, keyOf(src))?.phase, 'idle', 'src is still listed');
    assert.ok(rowOf(api, dep), 'dep.ts must still be listed as referenced by the idle src.ts; the unrelated rename must not drop it');
  });

  test('references follow the text of the open document: adding, swapping and removing an import updates the yellow rows', async function () {
    this.timeout(90_000);
    const dir = scratch('follow-text');
    const made = await createSettled(api, dir, { 'b1.ts': 'export {};\n', 'c1.ts': 'export {};\n', 't.ts': 'export {};\n' });
    const t = must(made['t.ts']);
    const b1 = keyOf(must(made['b1.ts']));
    const c1 = keyOf(must(made['c1.ts']));
    const doc = await openDoc(t);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const apply = async (build: (e: vscode.TextEditorEdit) => void): Promise<void> => {
      const before = trackedOf(api, keyOf(t))?.editCount ?? 0;
      assert.equal(await editor.edit(build), true);
      await waitUntil(api, () => (trackedOf(api, keyOf(t))?.editCount ?? 0) > before, 'the edit to be recorded');
      testing(api).advance(100);
      await settleRefs(api);
    };
    await apply((b) => b.insert(new vscode.Position(0, 0), "import './b1';\n"));
    await waitUntil(api, () => rowOf(api, b1)?.role === 'referenced', 'b1 after adding the import', 30_000);
    assert.equal(rowOf(api, c1), undefined);
    await apply((b) => b.replace(new vscode.Range(0, 0, 1, 0), "import './c1';\n"));
    await waitUntil(api, () => rowOf(api, c1)?.role === 'referenced' && rowOf(api, b1) === undefined, 'c1 instead of b1 after swapping the import', 30_000);
    await apply((b) => b.delete(new vscode.Range(0, 0, 1, 0)));
    await waitUntil(api, () => rowOf(api, c1) === undefined, 'no reference after removing the import', 30_000);
    assert.equal(api.getRows().filter((r) => r.role === 'referenced').length, 0);
  });

  test('[QA-004] turning showWhenIdle off while a file is idle (inside the retain window) must schedule its removal, otherwise the row never goes away', async function () {
    this.timeout(90_000);
    await setConfig('showWhenIdle', true);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    testing(api).advance(3000); // idle for 500 ms of its 4000 ms retain window ... the tick chain has stopped (showWhenIdle keeps idle rows without a tick)
    assert.equal(must(trackedOf(api, keyOf(a))).phase, 'idle');
    assert.equal(testing(api).pendingTimers(), 0, 'precondition: with showWhenIdle on and nothing active no timer runs');
    await setConfig('showWhenIdle', false);
    await waitUntil(api, () => vscode.workspace.getConfiguration('fileShake').get('showWhenIdle') === false, 'the setting to change');
    testing(api).advance(0);
    assert.ok(trackedOf(api, keyOf(a)), 'still inside the retain window, so the row is (correctly) still listed');
    assert.ok(testing(api).pendingTimers() >= 1, 'a removal tick must be pending: without one the idle row stays on screen until something else happens');
    // and the chain really removes it
    testing(api).advance(4000);
    assert.equal(trackedOf(api, keyOf(a)), undefined);
    assert.equal(testing(api).pendingTimers(), 0);
  });

  test('[QA-006] a checkout that rewrites 45 files whose documents are already open must be suppressed like any other flood (BurstGuard), not shown as 40 external edits', async function () {
    this.timeout(180_000);
    const dir = scratch('checkout');
    const names = Array.from({ length: 45 }, (_, i) => `c${String(i).padStart(2, '0')}.ts`);
    const paths = names.map((n) => writeFile(dir, n, 'export const v = 1;\n'));
    await waitUntil(api, () => logFor(api, (e) => e.reason === 'burst').length >= 1, 'the creation flood to be seen', 60_000);
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(paths[44] as string)).length >= 1, 'the creation of the last file to be processed', 60_000);
    await resetState(api);
    testing(api).overrideFocus(true);
    testing(api).advance(5000);
    // every file has an open, clean document (VS Code keeps the models around)
    const docs: vscode.TextDocument[] = [];
    for (const f of paths) docs.push(await openDoc(f));
    // one external process rewrites all of them within a few milliseconds (a branch switch)
    const code = `const fs=require('fs');for(const f of ${JSON.stringify(paths)})fs.writeFileSync(f,'export const v = 2; // checkout\\n');`;
    await runNode(code);
    await waitUntilAdvancing(api, 10, () => docs.every((d) => d.getText().includes('v = 2')), 'every open document to be reloaded from disk', 90_000);
    await waitUntilAdvancing(api, 10, () => logFor(api, (e) => e.origin === 'doc' && (e.reason === 'reload-from-disk' || e.reason === 'dedupe' || e.reason === 'burst')).length >= 40 || api.getTracked().length >= 40, 'the reload events to be classified', 60_000);
    const tracked = api.getTracked().filter((t) => paths.includes(t.key));
    assert.ok(tracked.length <= 31, `${tracked.length} of 45 reloaded files were shown; a flood above the burst limit (30 files/s) must be suppressed`);
  });

  test('renaming a folder that contains a tracked file re-keys the state and leaves nothing under the old name', async function () {
    this.timeout(90_000);
    const dir = scratch('folder-rename');
    const f = writeFile(dir, 'sub/inner.ts', 'export {};\n');
    await waitUntil(api, () => trackedOf(api, keyOf(f)) !== undefined, 'the file to be tracked', 45_000);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(join(dir, 'sub')), vscode.Uri.file(join(dir, 'sub2')));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const moved = keyOf(join(dir, 'sub2', 'inner.ts'));
    await waitUntil(api, () => trackedOf(api, moved) !== undefined && trackedOf(api, keyOf(f)) === undefined, 'the state to move under the new folder name', 45_000);
    assert.equal(rowOf(api, keyOf(f)), undefined);
    assert.deepEqual(must(rowOf(api, moved)).folderPath.slice(-1), ['sub2']);
  });

  test('[QA-005] renaming a file you are typing in keeps it labelled as typing (a workbench rename is not an external edit)', async function () {
    this.timeout(90_000);
    const dir = scratch('rename-typing');
    const made = await createSettled(api, dir, { 'typed.ts': 'export {};\n' });
    const f = must(made['typed.ts']);
    const doc = await openDoc(f);
    await typeAndWait(api, doc, '// typing');
    assert.equal(must(trackedOf(api, keyOf(f))).source, 'you');
    const renamed = join(dir, 'typed-renamed.ts');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(f), vscode.Uri.file(renamed));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitUntil(api, () => trackedOf(api, keyOf(renamed)) !== undefined && trackedOf(api, keyOf(f)) === undefined, 'the state to move to the new name', 45_000);
    // let the watcher's delete/create echoes of the rename arrive
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(renamed) && e.origin === 'watcher').length >= 1, 'the watcher echo of the rename', 30_000);
    assert.equal(must(trackedOf(api, keyOf(renamed))).source, 'you', 'the rename echo must not turn typing into an external edit');
  });

  test('format-on-save style edits made while the document is being saved are not activity', async function () {
    this.timeout(60_000);
    const dir = scratch('fmt-on-save');
    const made = await createSettled(api, dir, { 'fmt.ts': 'export const x = 1;\n' });
    const f = must(made['fmt.ts']);
    const doc = await openDoc(f);
    const prior = stampOf(keyOf(f));
    const typed = await typeAndWait(api, doc, ' ');
    const formatter = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document.uri.fsPath === f) e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), '/* formatted */\n')]));
    });
    try {
      assert.equal(await doc.save(), true);
    } finally {
      formatter.dispose();
    }
    assert.ok(doc.getText().startsWith('/* formatted */'), 'the save-time edit was applied');
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.origin === 'watcher' && e.at > prior).length >= 1, 'the watcher echo of the save', 45_000);
    const now = must(trackedOf(api, keyOf(f)));
    assert.equal(now.editCount, typed.editCount, 'neither the formatter edit nor the save echo counted as activity');
    assert.equal(now.source, 'you');
    assert.ok(logFor(api, (e) => e.key === keyOf(f) && e.at > prior && e.reason === 'saving').length >= 1, 'the save-time edit was recognised as "saving"');
  });

  test('autosave: the save and its watcher echo are not activity', async function () {
    this.timeout(60_000);
    const files = vscode.workspace.getConfiguration('files');
    touchedSettings.push(['files.autoSave', files.inspect('autoSave')?.globalValue], ['files.autoSaveDelay', files.inspect('autoSaveDelay')?.globalValue]);
    await files.update('autoSaveDelay', 100, vscode.ConfigurationTarget.Global);
    await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
    const dir = scratch('autosave');
    const made = await createSettled(api, dir, { 'auto.ts': 'export const x = 1;\n' });
    const f = must(made['auto.ts']);
    const doc = await openDoc(f);
    const prior = stampOf(keyOf(f));
    const typed = await typeAndWait(api, doc, ' ');
    await waitUntil(api, () => !doc.isDirty, 'autosave to write the file', 30_000);
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.origin === 'watcher' && e.at > prior).length >= 1, 'the watcher echo of the autosave', 45_000);
    const now = must(trackedOf(api, keyOf(f)));
    assert.equal(now.editCount, typed.editCount, 'autosave must not add activity');
    assert.equal(now.source, 'you');
    assert.ok(logFor(api, (e) => e.key === keyOf(f) && e.origin === 'watcher' && e.at > prior && e.reason === 'self-save').length >= 1, JSON.stringify(logFor(api, (e) => e.key === keyOf(f))));
    // typing again after the autosave still counts as typing (the document went clean and dirty again)
    testing(api).advance(500);
    const again = await typeAndWait(api, doc, ' ');
    assert.equal(again.source, 'you');
    assert.equal(again.editCount, typed.editCount + 1);
  });

  test('a document opened and edited with the window unfocused, then refocused, flips to typing on the next keystroke', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    const doc = await openDoc(a);
    testing(api).overrideFocus(false);
    await typeAndWait(api, doc);
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'external');
    testing(api).overrideFocus(true);
    testing(api).advance(400);
    await typeAndWait(api, doc);
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'you');
    assert.ok(decorationOf(api, a)?.badge === '●');
  });

  test('changing excludeGlobs live removes already-listed references that the new globs exclude', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(join(ws, 'b.ts'))) !== undefined, 'b.ts to be referenced', 45_000);
    await setConfig('excludeGlobs', ['**/b.ts']);
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(join(ws, 'b.ts'))) === undefined, 'b.ts to disappear once excluded', 30_000);
    assert.ok(rowOf(api, keyOf(join(ws, 'c.ts'))), 'c.ts is untouched');
  });
});
