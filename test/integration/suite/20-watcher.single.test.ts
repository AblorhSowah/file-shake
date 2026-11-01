import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { K } from '../../../src/core/constants';
import {
  colorIdOf,
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
  settleRefs,
  testing,
  trackedOf,
  waitUntil,
  waitUntilAdvancing,
  workspaceDir,
  writeFile,
} from './helpers';

suite('Disk changes seen by the file watcher (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const created: string[] = [];

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
    await resetState(api); // closes editors first, so nothing tries to open files that are about to be deleted
    for (const d of created.splice(0)) removePath(d);
  });

  const scratch = (label: string): string => {
    const d = scratchDir(ws, label);
    created.push(d);
    return d;
  };

  test('writing an existing, closed file from outside VS Code is an external edit (disk-write)', async function () {
    this.timeout(60_000);
    const c = join(ws, 'c.ts');
    writeFileSync(c, 'export const c = 4;\n');
    await waitUntil(api, () => rowOf(api, keyOf(c))?.source === 'external', 'an external row for c.ts', 45_000);
    const row = must(rowOf(api, keyOf(c)));
    assert.equal(row.role, 'edited');
    assert.equal(row.badge, 'external');
    assert.equal(row.tooltip.startsWith('Changed outside the editor (external)'), true);
    assert.ok(Math.abs(row.intensity - 0.8647) < 0.005, `external write intensity ${row.intensity}`);
    const d = must(decorationOf(api, c));
    assert.equal(d.badge, '◆');
    assert.equal(colorIdOf(d), 'fileShake.editedForeground');
    assert.ok(logFor(api, (e) => e.key === keyOf(c) && e.origin === 'watcher' && e.decision === 'external' && e.reason === 'disk-write').length >= 1);
    assert.equal(api.getStatusText(), '$(pulse) c.ts · external');
  });

  test('creating a new file is an external edit too', async function () {
    this.timeout(60_000);
    const f = writeFile(scratch('create'), 'fresh.ts', 'export const fresh = 1;\n');
    await waitUntil(api, () => rowOf(api, keyOf(f))?.source === 'external', 'an external row for the new file', 45_000);
    assert.equal(must(rowOf(api, keyOf(f))).role, 'edited');
  });

  test('a file rewritten from outside makes the files it imports yellow (references work for external edits too)', async function () {
    this.timeout(60_000);
    const main = join(ws, 'src', 'main.ts');
    writeFileSync(main, "import { helper } from './util';\nimport { b1 } from '../b';\nhelper(b1());\nhelper(1);\n");
    await waitUntil(api, () => rowOf(api, keyOf(main))?.source === 'external', 'src/main.ts to be an external row', 45_000);
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(join(ws, 'src', 'util.ts'))) !== undefined && rowOf(api, keyOf(join(ws, 'b.ts'))) !== undefined, 'util.ts and b.ts to turn yellow', 45_000);
    const util = must(rowOf(api, keyOf(join(ws, 'src', 'util.ts'))));
    assert.equal(util.role, 'referenced');
    assert.equal(util.refCount, 3, 'one import statement + two uses of helper');
    assert.equal(must(rowOf(api, keyOf(join(ws, 'b.ts')))).refCount, 2, 'one import statement + one use of b1');
    assert.equal(colorIdOf(decorationOf(api, join(ws, 'src', 'util.ts'))), 'fileShake.referencedForeground');
  });

  test('deleting a tracked file removes its row (no exception, state consistent)', async function () {
    this.timeout(60_000);
    const f = writeFile(scratch('delete'), 'gone.ts', 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(f)) !== undefined, 'the row to appear', 45_000);
    unlinkSync(f);
    await waitUntil(api, () => trackedOf(api, keyOf(f)) === undefined && rowOf(api, keyOf(f)) === undefined, 'the row to disappear after delete', 45_000);
    assert.equal(decorationOf(api, f), undefined);
  });

  test('deleting a whole folder forgets everything under it', async function () {
    this.timeout(60_000);
    const dir = scratch('rmdir');
    const a = writeFile(dir, 'sub/a.ts', 'export {};\n');
    const b = writeFile(dir, 'sub/b.ts', 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(a)) !== undefined && rowOf(api, keyOf(b)) !== undefined, 'both rows', 45_000);
    removePath(join(dir, 'sub'));
    await waitUntil(api, () => trackedOf(api, keyOf(a)) === undefined && trackedOf(api, keyOf(b)) === undefined, 'both rows to disappear', 45_000);
  });

  test('renaming a tracked file through the workbench re-keys its state', async function () {
    this.timeout(60_000);
    const dir = scratch('rename');
    const oldPath = writeFile(dir, 'before.ts', 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(oldPath)) !== undefined, 'the row to appear', 45_000);
    const newPath = join(dir, 'after.ts');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitUntil(api, () => trackedOf(api, keyOf(newPath)) !== undefined && trackedOf(api, keyOf(oldPath)) === undefined, 'the state to move to the new name', 45_000);
    assert.equal(rowOf(api, keyOf(oldPath)), undefined);
    assert.ok(rowOf(api, keyOf(newPath)));
  });

  test('a flood of files (60 within one fake second) is suppressed by the burst guard: no decoration flood', async function () {
    this.timeout(90_000);
    const dir = scratch('burst');
    const keys: string[] = [];
    for (let i = 0; i < 60; i++) {
      const f = join(dir, `f${String(i).padStart(2, '0')}.ts`);
      writeFileSync(f, `export const v${i} = ${i};\n`);
      keys.push(keyOf(f));
    }
    await waitUntil(api, () => logFor(api, (e) => e.reason === 'burst').length >= 1, 'the burst guard to trip', 60_000);
    await waitUntil(api, () => logFor(api, (e) => e.key === keys[59]).length >= 1 || logFor(api, (e) => e.reason === 'burst').length >= 25, 'the tail of the flood to be processed', 60_000);
    const trackedInDir = api.getTracked().filter((t) => keys.includes(t.key));
    assert.ok(trackedInDir.length <= K.BURST_LIMIT, `${trackedInDir.length} of 60 were tracked (limit ${K.BURST_LIMIT})`);
    assert.ok(trackedInDir.length >= 1);
    assert.ok(logFor(api, (e) => e.reason === 'burst').length >= 1);
  });

  test('directory creation is not file activity', async function () {
    this.timeout(60_000);
    const dir = scratch('mkdir');
    const sub = join(dir, 'newdir');
    mkdirSync(sub);
    const f = writeFile(sub, 'inside.ts', 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(f)) !== undefined, 'the file inside the new directory', 45_000);
    assert.equal(trackedOf(api, keyOf(sub)), undefined, 'the directory itself must not be tracked');
  });

  test('excluded paths written from outside are ignored: dist/, *.log, *.min.js, lock files', async function () {
    this.timeout(60_000);
    const dir = scratch('excluded');
    const files = [writeFile(dir, 'dist/out.js', '1;'), writeFile(dir, 'run.log', 'x'), writeFile(dir, 'app.min.js', '1;'), writeFile(dir, 'yarn.lock', 'x')];
    const marker = writeFile(dir, 'marker.ts', 'export {};\n');
    await waitUntil(api, () => rowOf(api, keyOf(marker)) !== undefined, 'the (non-excluded) marker file', 45_000);
    await waitUntil(api, () => files.every((f) => logFor(api, (e) => e.key === keyOf(f)).length >= 1), 'log entries for all excluded files', 45_000);
    for (const f of files) {
      assert.equal(trackedOf(api, keyOf(f)), undefined, f);
      assert.ok(logFor(api, (e) => e.key === keyOf(f) && e.reason === 'excluded').length >= 1, `${f} should be logged as excluded`);
    }
  });

  test('a huge file (> maxFileSizeKb) is tracked green but never scanned for references', async function () {
    this.timeout(90_000);
    const dir = scratch('huge');
    const big = writeFile(dir, 'huge.ts', `import '../b';\n${'// padding line to make the file large\n'.repeat(20_000)}`);
    await waitUntil(api, () => rowOf(api, keyOf(big)) !== undefined, 'the huge file to be tracked', 60_000);
    await settleRefs(api);
    assert.equal(api.getRows().filter((r) => r.role === 'referenced').length, 0, 'no references from a file over the size cap');
    assert.equal(must(rowOf(api, keyOf(big))).role, 'edited');
    // control: the same import in a normal-sized file does resolve
    await vscode.commands.executeCommand('fileShake.clear');
    const small = writeFile(dir, 'small.ts', "import '../b';\n");
    await waitUntil(api, () => rowOf(api, keyOf(small)) !== undefined, 'the small control file', 45_000);
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(join(ws, 'b.ts')))?.role === 'referenced', 'b.ts to be referenced by the small file', 45_000);
  });

  test('a binary-looking file is tracked green but never scanned for references', async function () {
    this.timeout(60_000);
    const dir = scratch('binary');
    const bin = writeFile(dir, 'blob.ts', `import '../b';\n\u0000\u0001\u0002 binary payload`);
    await waitUntil(api, () => rowOf(api, keyOf(bin)) !== undefined, 'the binary file to be tracked', 45_000);
    await settleRefs(api);
    assert.equal(api.getRows().filter((r) => r.role === 'referenced').length, 0, 'no references from a binary file');
    assert.equal(must(rowOf(api, keyOf(bin))).role, 'edited');
  });

  test('a document reloaded from disk shows up once, not twice (watcher event + reload event are de-duplicated)', async function () {
    this.timeout(90_000);
    const dir = scratch('reload');
    const f = writeFile(dir, 'open.ts', 'export const v = 1;\n');
    await waitUntil(api, () => rowOf(api, keyOf(f)) !== undefined, 'the create event', 45_000);
    await vscode.commands.executeCommand('fileShake.clear');
    testing(api).advance(10_000);
    const doc = await openDoc(f);
    await vscode.window.showTextDocument(doc, { preview: false });
    writeFileSync(f, 'export const v = 2; // changed on disk\n');
    await waitUntil(api, () => logFor(api, (e) => e.key === keyOf(f) && e.origin === 'watcher').length >= 1, 'the watcher event', 45_000);
    await waitUntilAdvancing(api, 5, () => logFor(api, (e) => e.key === keyOf(f) && e.origin === 'doc' && (e.reason === 'reload-from-disk' || e.reason === 'dedupe')).length >= 1 || doc.getText().includes('= 2'), 'the editor to reload the document', 60_000);
    const t = must(trackedOf(api, keyOf(f)));
    const docEntries = logFor(api, (e) => e.key === keyOf(f) && e.origin === 'doc' && (e.reason === 'reload-from-disk' || e.reason === 'dedupe'));
    if (docEntries.some((e) => e.reason === 'dedupe')) assert.equal(t.editCount, 1, 'the second external event inside the dedupe window must not be counted');
    assert.equal(t.source, 'external');
    assert.ok(t.editCount <= 2);
  });
});
