import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { K } from '../../../src/core/constants';
import { referenceIntensity } from '../../../src/core/intensity';
import {
  colorIdOf,
  decorationOf,
  envPath,
  getApi,
  keyOf,
  logFor,
  must,
  openDoc,
  resetConfig,
  resetState,
  rowOf,
  settleRefs,
  testing,
  trackedOf,
  typeAndWait,
  typeInto,
  waitUntil,
  workspaceDir,
} from './helpers';

suite('Editing a file (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const p = (rel: string): string => join(ws, rel);

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

  test('typing in the focused editor creates an edited/you row with the documented fields', async () => {
    const a = p('a.ts');
    const doc = await openDoc(a);
    await typeAndWait(api, doc);
    const row = must(rowOf(api, keyOf(a)), 'row for a.ts');
    assert.equal(row.role, 'edited');
    assert.equal(row.source, 'you');
    assert.equal(row.phase, 'active');
    assert.equal(row.badge, 'typing');
    assert.equal(row.name, 'a.ts');
    assert.equal(row.uri, vscode.Uri.file(a).toString());
    assert.deepEqual(row.folderPath, []);
    assert.equal(row.dir, '');
    assert.equal(row.refCount, 0);
    assert.ok(row.intensity > 0 && row.intensity <= 1);
    assert.match(row.tooltip, /^Edited by you \(typing\) · \d+ edits?$/);
    const t = must(trackedOf(api, keyOf(a)), 'tracked a.ts');
    assert.equal(t.source, 'you');
    assert.ok(t.editCount >= 1);
    assert.ok(logFor(api, (e) => e.key === keyOf(a) && e.origin === 'doc' && e.decision === 'you' && e.reason === 'active-focused-edit').length >= 1);
  });

  test('the native decoration for the edited file: "●", the edited theme colour, a File Shake tooltip, propagate', async () => {
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    const d = must(decorationOf(api, a), 'decoration');
    assert.equal(d.badge, '●');
    assert.equal(colorIdOf(d), 'fileShake.editedForeground');
    assert.ok((d.tooltip ?? '').startsWith('File Shake: '));
    assert.equal(d.propagate, true);
  });

  test('the status bar text names the file and the state', async () => {
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    assert.equal(api.getStatusText(), '$(pulse) a.ts · typing');
  });

  test('files imported by the edited file turn yellow with their reference counts (b: 1 statement + 3 usages, c: 1)', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(p('b.ts'))) !== undefined, 'b.ts to appear as a referenced row');
    const b = must(rowOf(api, keyOf(p('b.ts'))));
    assert.equal(b.role, 'referenced');
    assert.equal(b.source, null);
    assert.equal(b.refCount, 4);
    assert.equal(b.badge, '×4 refs');
    assert.equal(b.tooltip, 'Referenced 4× by a.ts');
    assert.ok(Math.abs(b.intensity - referenceIntensity(4, 1)) < 1e-9);
    const c = must(rowOf(api, keyOf(p('c.ts'))));
    assert.equal(c.refCount, 1);
    assert.equal(c.badge, '×1 ref');
    const db = must(decorationOf(api, p('b.ts')));
    assert.equal(db.badge, '4');
    assert.equal(colorIdOf(db), 'fileShake.referencedForeground');
    assert.equal(must(decorationOf(api, p('c.ts'))).badge, '1');
    assert.equal(decorationOf(api, p('notes.txt')), undefined, 'unrelated files get no decoration');
    assert.equal(api.getStatusText(), '$(pulse) a.ts · typing · 2 refs');
  });

  test('green wins: a referenced file that is then edited is ONE edited row, not a yellow one', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(p('a.ts')));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(p('b.ts')))?.role === 'referenced', 'b.ts to be yellow');
    await typeAndWait(api, await openDoc(p('b.ts')));
    await waitUntil(api, () => rowOf(api, keyOf(p('b.ts')))?.role === 'edited', 'b.ts to turn green');
    assert.equal(api.getRows().filter((r) => r.id === keyOf(p('b.ts'))).length, 1);
    assert.equal(must(decorationOf(api, p('b.ts'))).badge, '●');
    assert.equal(colorIdOf(decorationOf(api, p('b.ts'))), 'fileShake.editedForeground');
    assert.equal(rowOf(api, keyOf(p('c.ts')))?.role, 'referenced', 'c.ts is still referenced by a.ts');
  });

  test('references in other languages: Python (pkg.mod as m, relative util) and SCSS partials', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(p('py/app.py')));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(p('py/pkg/mod.py'))) !== undefined && rowOf(api, keyOf(p('py/util.py'))) !== undefined, 'python targets');
    assert.equal(must(rowOf(api, keyOf(p('py/pkg/mod.py')))).refCount, 3);
    assert.equal(must(rowOf(api, keyOf(p('py/util.py')))).refCount, 3);

    await vscode.commands.executeCommand('fileShake.clear');
    await typeAndWait(api, await openDoc(p('styles/main.scss')));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(p('styles/_vars.scss'))) !== undefined, 'the scss partial');
    assert.equal(must(rowOf(api, keyOf(p('styles/_vars.scss')))).role, 'referenced');
  });

  test('files in sub folders carry their folder path', async () => {
    await typeAndWait(api, await openDoc(p('src/lib/deep.ts')));
    const row = must(rowOf(api, keyOf(p('src/lib/deep.ts'))));
    assert.deepEqual(row.folderPath, ['src', 'lib']);
    assert.equal(row.dir, 'src/lib');
  });

  test('intensity follows the typing rate on the fake clock (1 key = 0.2835, 15 keys at 5/s = 0.5905)', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    const doc = await openDoc(a);
    const first = await typeAndWait(api, doc);
    assert.ok(Math.abs(first.intensity - 0.2835) < 0.005, `single keystroke intensity ${first.intensity}`);
    await vscode.commands.executeCommand('fileShake.clear');
    testing(api).advance(10_000);
    for (let k = 1; k <= 15; k++) {
      testing(api).advance(200);
      await typeAndWait(api, doc);
    }
    const t = must(trackedOf(api, keyOf(a)));
    assert.equal(t.editCount, 15);
    assert.ok(Math.abs(t.rate - 5.357) < 0.01, `rate ${t.rate}`);
    assert.ok(Math.abs(t.intensity - 0.5905) < 0.005, `intensity ${t.intensity}`);
    assert.ok(must(rowOf(api, keyOf(a))).shake.amp > 0);
  });

  test('a 500 character paste is one big burst (intensity 0.9639)', async () => {
    const a = p('a.ts');
    const doc = await openDoc(a);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, 'x'.repeat(500)));
    await waitUntil(api, () => trackedOf(api, keyOf(a)) !== undefined, 'the paste to be recorded');
    const t = must(trackedOf(api, keyOf(a)));
    assert.ok(Math.abs(t.intensity - 0.9639) < 0.005, `intensity ${t.intensity}`);
    assert.equal(t.editCount, 1);
  });

  test('idle: the row goes idle at exactly idleTimeoutMs, the decoration and the yellow rows disappear, the row is removed after the retain period', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    testing(api).advance(K.TICK_MS);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'active');
    // idle boundary: t = 2500 since the last edit (we are at 401 + 200)
    testing(api).advance(2500 - (K.REF_DEBOUNCE_MS + 1) - K.TICK_MS - 1);
    assert.equal(must(rowOf(api, keyOf(a))).phase, 'active', '1 ms before the boundary');
    testing(api).advance(1);
    const idle = must(rowOf(api, keyOf(a)));
    assert.equal(idle.phase, 'idle');
    assert.equal(idle.intensity, 0);
    assert.deepEqual(idle.shake, { amp: 0, dur: 160, rot: 0 });
    assert.equal(decorationOf(api, a), undefined, 'retained/fading rows carry no native decoration');
    assert.equal(rowOf(api, keyOf(p('b.ts'))), undefined, 'yellow rows exist only while their source is active (showWhenIdle is off)');
    testing(api).advance(K.RETAIN_AFTER_IDLE_MS - 1);
    assert.ok(rowOf(api, keyOf(a)), 'still retained 1 ms before the end of the retain window');
    testing(api).advance(1);
    assert.deepEqual(api.getRows(), []);
  });

  test('a window that is not focused makes an edit "external" (background-edit) with the diamond badge', async () => {
    testing(api).overrideFocus(false);
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    const row = must(rowOf(api, keyOf(a)));
    assert.equal(row.source, 'external');
    assert.equal(row.badge, 'external');
    assert.equal(must(decorationOf(api, a)).badge, '◆');
    assert.ok(logFor(api, (e) => e.key === keyOf(a) && e.reason === 'background-edit').length >= 1);
  });

  test('a WorkspaceEdit on a document that is not the focused editor is external (background-edit)', async () => {
    const b = p('b.ts');
    const doc = await openDoc(b);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, '// agent edit\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitUntil(api, () => rowOf(api, keyOf(b))?.source === 'external', 'b.ts to be external');
    assert.ok(logFor(api, (e) => e.key === keyOf(b) && e.reason === 'background-edit').length >= 1);
  });

  test('undo is classified as you (undo-redo), never as a reload', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    const doc = await openDoc(a);
    const typed = await typeAndWait(api, doc);
    // The event log is a ring buffer shared by all tests: only entries stamped after `mark` belong to this test.
    testing(api).advance(1000);
    const mark = typed.lastEditAt + 1000;
    const mine = (e: { key: string; at: number }): boolean => e.key === keyOf(a) && e.at >= mark;
    // `undo` acts on the FOCUSED editor; when another window (e.g. a second VS Code on the machine) has the OS focus it can be a
    // no-op, so focus the editor group explicitly and retry a few times before giving up.
    let undone = false;
    for (let attempt = 0; attempt < 4 && !undone; attempt++) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand('undo');
      try {
        await waitUntil(api, () => logFor(api, (e) => mine(e) && e.reason === 'undo-redo').length >= 1, 'an undo-redo log entry', 6_000);
        undone = true;
      } catch {
        /* retry */
      }
    }
    assert.ok(undone, 'the undo command produced no undo-redo event after 4 attempts');
    const after = logFor(api, mine);
    assert.deepEqual(
      after.filter((e) => e.reason === 'reload-from-disk'),
      [],
      `undoing back to the clean state must not look like a reload: ${JSON.stringify(after)}`,
    );
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'you');
  });

  test('saving is not activity: no new edit is recorded for the save itself or for the watcher echo of our own save', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    const doc = await openDoc(a);
    const typed = await typeAndWait(api, doc);
    testing(api).advance(1000);
    const mark = typed.lastEditAt + 1000;
    const mine = (e: { key: string; at: number }): boolean => e.key === keyOf(a) && e.at >= mark;
    assert.equal(await doc.save(), true);
    await waitUntil(api, () => logFor(api, (e) => mine(e) && e.origin === 'watcher').length >= 1, 'the watcher echo of the save', 45_000);
    const after = logFor(api, mine);
    assert.deepEqual(
      after.filter((e) => e.decision !== 'ignore'),
      [],
      `saving must not add accepted activity: ${JSON.stringify(after)}`,
    );
    assert.equal(must(trackedOf(api, keyOf(a))).editCount, typed.editCount, 'saving must not change the edit count');
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'you');
    assert.ok(after.some((e) => e.origin === 'watcher' && e.reason === 'self-save'), `the echo is recognised as our own save: ${JSON.stringify(after)}`);
  });

  test('untitled / non-file documents are ignored (scheme)', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'import "./b";\n' });
    await typeInto(doc);
    await waitUntil(api, () => logFor(api, (e) => e.reason === 'scheme').length >= 1, 'a "scheme" log entry');
    assert.deepEqual(api.getTracked(), []);
    assert.deepEqual(api.getRows(), []);
  });

  test('excluded paths (node_modules) are ignored', async () => {
    const f = p('node_modules/pkg/index.js');
    await typeInto(await openDoc(f));
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.reason === 'excluded').length >= 1, 'an "excluded" log entry');
    assert.equal(trackedOf(api, keyOf(f)), undefined);
  });

  test('the clear command empties rows, tracker and decorations', async () => {
    const a = p('a.ts');
    await typeAndWait(api, await openDoc(a));
    assert.ok(rowOf(api, keyOf(a)));
    await vscode.commands.executeCommand('fileShake.clear');
    assert.deepEqual(api.getRows(), []);
    assert.deepEqual(api.getTracked(), []);
    assert.equal(decorationOf(api, a), undefined);
    assert.equal(api.getStatusText(), '$(pulse) File Shake');
  });

  test('a symlinked import target counts (isFile is true for symlinked files, no realpath)', async function () {
    this.timeout(60_000);
    if (process.env['FS_TEST_SYMLINK'] !== '1' || !existsSync(p('link.ts'))) return this.skip();
    await typeAndWait(api, await openDoc(p('symsrc.ts')));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(p('link.ts'))) !== undefined, 'the symlinked target to appear');
    assert.equal(must(rowOf(api, keyOf(p('link.ts')))).role, 'referenced');
  });

  test('a file outside the workspace is tracked, decorated, shown under "(outside workspace)", and its neighbours resolve', async function () {
    this.timeout(60_000);
    const o1 = join(envPath('FS_TEST_OUTSIDE'), 'o1.ts');
    const o2 = join(envPath('FS_TEST_OUTSIDE'), 'o2.ts');
    await typeAndWait(api, await openDoc(o1));
    const row = must(rowOf(api, keyOf(o1)));
    assert.equal(row.folderPath[0], '(outside workspace)');
    assert.equal(row.dir, keyOf(envPath('FS_TEST_OUTSIDE')));
    assert.equal(must(decorationOf(api, o1)).badge, '●');
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(o2)) !== undefined, 'the neighbour outside the workspace to resolve');
    assert.equal(must(rowOf(api, keyOf(o2))).role, 'referenced');
  });

  test('editing two files shows both; the most recently edited sorts first', async function () {
    this.timeout(60_000);
    await typeAndWait(api, await openDoc(p('c.ts')));
    testing(api).advance(500);
    await typeAndWait(api, await openDoc(p('src/util.ts')));
    const ids = api.getRows().filter((r) => r.role === 'edited').map((r) => r.id);
    assert.deepEqual(ids, [keyOf(p('src/util.ts')), keyOf(p('c.ts'))]);
  });

  test('external edit followed by typing: source follows the last accepted event', async function () {
    this.timeout(60_000);
    const a = p('a.ts');
    const doc = await openDoc(a);
    testing(api).overrideFocus(false);
    await typeAndWait(api, doc);
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'external');
    testing(api).overrideFocus(true);
    testing(api).advance(500);
    await typeAndWait(api, doc);
    assert.equal(must(trackedOf(api, keyOf(a))).source, 'you');
  });

  test('two hundred rapid edits are all recorded, the model stays bounded and the intensity stays in range', async function () {
    this.timeout(90_000);
    const a = p('a.ts');
    const doc = await openDoc(a);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    for (let i = 0; i < 200; i++) {
      const ok = await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, 'x'));
      assert.equal(ok, true);
      testing(api).advance(5);
    }
    await waitUntil(api, () => (trackedOf(api, keyOf(a))?.editCount ?? 0) >= 200, 'all 200 edits to be recorded', 60_000);
    const t = must(trackedOf(api, keyOf(a)));
    assert.equal(t.editCount, 200);
    assert.ok(t.intensity > 0.9 && t.intensity <= 1, `a sustained 200 edits/s burst should be near the maximum: ${t.intensity}`);
    assert.equal(api.getRows().filter((r) => r.id === keyOf(a)).length, 1);
  });

  test('unusual file names (spaces, brackets, hash, percent, unicode) are tracked and decorated', async function () {
    this.timeout(60_000);
    const odd = join(ws, 'sp ace & [br] #h %20 ünï 日本.ts');
    writeFileSync(odd, 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(odd)) !== undefined, 'a row for the oddly named file', 45_000);
    assert.equal(must(rowOf(api, keyOf(odd))).name, 'sp ace & [br] #h %20 ünï 日本.ts');
    assert.equal(must(decorationOf(api, odd)).badge, '◆');
    unlinkSync(odd);
    await waitUntil(api, () => trackedOf(api, keyOf(odd)) === undefined, 'the oddly named file to be forgotten', 45_000);
  });
});
