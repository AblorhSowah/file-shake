// Real-world scenarios in a real VS Code: genuine external processes, file lifecycles, reference fan-out,
// renames/deletes of referenced files, floods, and live settings with a view open.
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { K } from '../../../src/core/constants';
import { referenceIntensity } from '../../../src/core/intensity';
import {
  createSettled,
  decorationOf,
  externalWrite,
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

suite('Real-world scenarios (single-root workspace)', () => {
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

  const scratch = (label: string): string => {
    const d = scratchDir(ws, label);
    created.push(d);
    return d;
  };

  /** Latest fake-clock stamp in the log for `key`; entries added later have a strictly larger stamp once time has advanced. */
  const stampOf = (key: string): number => logFor(api, (e) => e.key === key).reduce((m, e) => Math.max(m, e.at), -Infinity);

  test('(a) an external process edits a file that is open and clean: one external edit, never "you"', async function () {
    this.timeout(90_000);
    const dir = scratch('ext-clean');
    const files = await createSettled(api, dir, { 'open.ts': 'export const v = 1;\n' });
    const f = must(files['open.ts']);
    const key = keyOf(f);
    const doc = await openDoc(f);
    await vscode.window.showTextDocument(doc, { preview: false });
    const before = stampOf(key);
    testing(api).advance(1000);
    await externalWrite(f, 'export const v = 2; // changed by another process\n');
    await waitUntilAdvancing(
      api,
      10,
      () => doc.getText().includes('v = 2') && trackedOf(api, key) !== undefined && logFor(api, (e) => e.key === key && e.at > before && e.origin === 'doc').length >= 1,
      'VS Code to reload the document and the extension to classify the reload',
      60_000,
    );
    const t = must(trackedOf(api, key));
    const added = logFor(api, (e) => e.key === key && e.at > before);
    assert.equal(doc.isDirty, false, 'the editor reloaded the clean document from disk');
    assert.deepEqual(
      added.filter((e) => e.decision === 'you'),
      [],
      `an edit by another process must never be attributed to the user: ${JSON.stringify(added)}`,
    );
    assert.equal(t.source, 'external');
    assert.ok(t.editCount <= 2, `watcher + reload are one change (deduplicated), got ${t.editCount}: ${JSON.stringify(added)}`);
    assert.ok(added.some((e) => e.origin === 'doc' && (e.reason === 'reload-from-disk' || e.reason === 'dedupe')), JSON.stringify(added));
    assert.equal(must(rowOf(api, key)).badge, 'external');
  });

  test('(b) an external process edits a file that is open and DIRTY: the change is seen as external, the user\'s unsaved text is untouched', async function () {
    this.timeout(90_000);
    const dir = scratch('ext-dirty');
    const files = await createSettled(api, dir, { 'dirty.ts': 'export const v = 1;\n' });
    const f = must(files['dirty.ts']);
    const key = keyOf(f);
    const doc = await openDoc(f);
    await typeAndWait(api, doc, '// my unsaved note');
    assert.equal(must(trackedOf(api, key)).source, 'you');
    testing(api).advance(1000);
    await externalWrite(f, 'export const v = 99; // from another process\n');
    await waitUntil(api, () => trackedOf(api, key)?.source === 'external', 'the on-disk change to be reported as external', 60_000);
    assert.equal(doc.isDirty, true, 'VS Code keeps the dirty buffer');
    assert.ok(doc.getText().includes('// my unsaved note'), 'the user text must survive');
    assert.ok(logFor(api, (e) => e.key === key && e.origin === 'watcher' && e.reason === 'disk-write').length >= 1);
    assert.equal(must(rowOf(api, key)).badge, 'external');
  });

  test('(c) three fast edits, then the file goes idle and disappears: row lifecycle edited -> idle -> removed', async function () {
    this.timeout(60_000);
    const a = join(ws, 'a.ts');
    const key = keyOf(a);
    const doc = await openDoc(a);
    await typeAndWait(api, doc);
    testing(api).advance(50);
    await typeAndWait(api, doc);
    testing(api).advance(50);
    const third = await typeAndWait(api, doc);
    assert.equal(third.editCount, 3);
    // events at +0, +50, +100 (w=1), now=+100 -> rate 6/s -> 1 - e^-1
    assert.ok(Math.abs(third.intensity - 0.6321) < 0.005, `intensity after three quick keystrokes: ${third.intensity}`);
    const active = must(rowOf(api, key));
    assert.equal(active.phase, 'active');
    assert.ok(must(decorationOf(api, join(ws, 'a.ts'))).badge === '●');
    testing(api).advance(2499);
    assert.equal(must(rowOf(api, key)).phase, 'active', '1 ms before idleTimeoutMs');
    testing(api).advance(1);
    const idle = must(rowOf(api, key));
    assert.equal(idle.phase, 'idle');
    assert.equal(idle.intensity, 0);
    assert.equal(decorationOf(api, join(ws, 'a.ts')), undefined);
    testing(api).advance(K.RETAIN_AFTER_IDLE_MS - 1);
    assert.ok(rowOf(api, key), 'still retained 1 ms before the end');
    testing(api).advance(1);
    assert.equal(rowOf(api, key), undefined, 'removed after idle + retain');
    assert.equal(trackedOf(api, key), undefined);
    assert.equal(testing(api).pendingTimers(), 0, 'and no timer is left behind');
  });

  test('(d) a file importing six others: reference counts 1..6 and intensity grows with the count', async function () {
    this.timeout(90_000);
    const dir = scratch('fanout');
    const lines: string[] = [];
    const files: Record<string, string> = {};
    for (let k = 1; k <= 6; k++) {
      files[`m${k}.ts`] = `export const m${k} = () => ${k};\n`;
      lines.push(`import { m${k} } from './m${k}';`);
    }
    // m_k is used (k-1) times: count = 1 import statement + (k-1) usages = k
    for (let k = 2; k <= 6; k++) lines.push(Array.from({ length: k - 1 }, () => `m${k}();`).join(' '));
    files['main.ts'] = `${lines.join('\n')}\n`;
    const made = await createSettled(api, dir, files);
    const main = must(made['main.ts']);
    await typeAndWait(api, await openDoc(main));
    await settleRefs(api);
    await waitUntil(api, () => api.getRows().filter((r) => r.role === 'referenced').length === 6, 'six yellow rows', 45_000);
    const refs = api.getRows().filter((r) => r.role === 'referenced');
    const byCount = new Map(refs.map((r) => [r.refCount, r]));
    for (let k = 1; k <= 6; k++) {
      const r = must(byCount.get(k), `a referenced row with count ${k}`);
      assert.ok(r.id.endsWith(`/m${k}.ts`), `${r.id} has count ${k}`);
      assert.ok(Math.abs(r.intensity - referenceIntensity(k, 1)) < 1e-9);
      assert.equal(r.badge, `×${k} ${k === 1 ? 'ref' : 'refs'}`);
      assert.equal(must(decorationOf(api, join(dir, `m${k}.ts`))).badge, String(k));
    }
    const sorted = [...refs].sort((a, b) => a.refCount - b.refCount);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(must(sorted[i]).intensity > must(sorted[i - 1]).intensity, 'intensity strictly increases with the count');
      assert.ok(must(sorted[i]).shake.amp > must(sorted[i - 1]).shake.amp, 'shake amplitude strictly increases with the count');
    }
    const top = must(sorted[5]);
    assert.ok(top.id.endsWith('/m6.ts'));
    assert.equal(top.intensity, Math.max(...refs.map((r) => r.intensity)));
    assert.deepEqual(
      api.getRows().filter((r) => r.role === 'referenced').map((r) => r.refCount),
      [6, 5, 4, 3, 2, 1],
      'referenced rows are listed by count, highest first',
    );
    assert.equal(api.getStatusText(), '$(pulse) main.ts · typing · 6 refs');
  });

  test('(e) a referenced file is renamed and another is deleted while its importer is being edited: no stale rows, no decorations, pipeline alive', async function () {
    this.timeout(90_000);
    const dir = scratch('rename-delete');
    const made = await createSettled(api, dir, {
      'dep1.ts': 'export const d1 = 1;\n',
      'dep2.ts': 'export const d2 = 2;\n',
      'main.ts': "import { d1 } from './dep1';\nimport { d2 } from './dep2';\nd1(); d2();\n",
    });
    const main = must(made['main.ts']);
    const dep1 = must(made['dep1.ts']);
    const dep2 = must(made['dep2.ts']);
    const mainDoc = await openDoc(main);
    await typeAndWait(api, mainDoc);
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, keyOf(dep1))?.role === 'referenced' && rowOf(api, keyOf(dep2))?.role === 'referenced', 'both deps yellow', 45_000);

    // rename dep1 through the workbench
    const renamed = join(dir, 'dep1-renamed.ts');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(dep1), vscode.Uri.file(renamed));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitUntil(api, () => rowOf(api, keyOf(dep1)) === undefined && decorationOf(api, dep1) === undefined, 'the old name to disappear from rows and decorations', 45_000);
    await settleRefs(api);
    assert.equal(rowOf(api, keyOf(dep1)), undefined, 'a re-analysis must not resurrect the old path (the import no longer resolves)');
    assert.equal(rowOf(api, keyOf(main))?.role, 'edited');
    assert.equal(rowOf(api, keyOf(dep2))?.role, 'referenced', 'the untouched dependency is still shown');

    // delete dep2 from disk
    unlinkSync(dep2);
    await waitUntil(api, () => rowOf(api, keyOf(dep2)) === undefined && decorationOf(api, dep2) === undefined, 'the deleted dependency to disappear', 45_000);
    await settleRefs(api);
    assert.equal(rowOf(api, keyOf(dep2)), undefined);

    // keep typing: the pipeline is alive, nothing is left pointing at the deleted/renamed files
    testing(api).advance(500);
    await typeAndWait(api, mainDoc);
    await settleRefs(api);
    const stale = api.getRows().filter((r) => r.id === keyOf(dep1) || r.id === keyOf(dep2));
    assert.deepEqual(stale, []);
    assert.equal(rowOf(api, keyOf(main))?.role, 'edited');
  });

  test('(f) 50 files created within one second: the burst guard bounds the work and the pipeline survives', async function () {
    this.timeout(90_000);
    const dir = scratch('flood50');
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) keys.push(keyOf(writeFile(dir, `f${String(i).padStart(2, '0')}.ts`, `export const v${i} = ${i};\n`)));
    await waitUntil(api, () => logFor(api, (e) => e.reason === 'burst').length >= 1, 'the burst guard to trip', 60_000);
    await waitUntil(api, () => logFor(api, (e) => e.key === keys[49]).length >= 1, 'the last file of the flood to be processed', 60_000);
    const tracked = api.getTracked().filter((t) => keys.includes(t.key));
    assert.ok(tracked.length >= 20 && tracked.length <= K.BURST_LIMIT, `${tracked.length} of 50 tracked (limit ${K.BURST_LIMIT})`);
    assert.ok(api.getRows().length <= 40, `rows are bounded by maxFiles: ${api.getRows().length}`);
    assert.ok(logFor(api, (e) => e.reason === 'burst').length >= 15);
    // after the cooldown a single legitimate external edit is picked up again
    testing(api).advance(K.BURST_COOLDOWN_MS + K.BURST_WINDOW_MS + 10);
    const later = join(dir, 'later.ts');
    await externalWrite(later, 'export const later = 1;\n');
    await waitUntil(api, () => trackedOf(api, keyOf(later)) !== undefined, 'the extension to recover after the flood', 60_000);
  });

  test('(g) toggling fileShake.enable while the view is open: the view gets the disabled and the enabled snapshot', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('fileShake.view.focus');
    await waitUntil(api, () => testing(api).viewStats().ready >= 1, 'the view to be ready', 90_000);
    const a = join(ws, 'a.ts');
    await typeAndWait(api, await openDoc(a));
    await waitUntil(api, () => testing(api).viewStats().sent >= 2, 'a snapshot with the edited row to reach the view', 45_000);
    const sentBefore = testing(api).viewStats().sent;
    await setConfig('enable', false);
    await waitUntil(api, () => !api.isEnabled(), 'disabled');
    await waitUntil(api, () => testing(api).viewStats().sent > sentBefore, 'the disabled snapshot to be pushed to the open view', 30_000);
    assert.equal(api.getSnapshot().enabled, false);
    assert.deepEqual(api.getRows(), []);
    assert.equal(testing(api).viewStats().visible, true, 'the view stays open');
    const sentDisabled = testing(api).viewStats().sent;
    await setConfig('enable', true);
    await waitUntil(api, () => api.isEnabled(), 'enabled');
    await waitUntil(api, () => testing(api).viewStats().sent > sentDisabled, 'the enabled snapshot to be pushed', 30_000);
    await typeAndWait(api, await openDoc(join(ws, 'c.ts')));
    assert.ok(rowOf(api, keyOf(join(ws, 'c.ts'))));
  });

  test('(h) an atomic replace (write a temp file, rename it over an open clean file) is one external edit of the target; the temp file does not linger', async function () {
    this.timeout(90_000);
    const dir = scratch('atomic');
    const made = await createSettled(api, dir, { 'target.ts': 'export const v = 1;\n' });
    const target = must(made['target.ts']);
    const key = keyOf(target);
    const doc = await openDoc(target);
    await vscode.window.showTextDocument(doc, { preview: false });
    const tmp = join(dir, '.target.ts.tmp-1234');
    await runNode(
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(tmp)},'export const v = 2; // atomic\\n');fs.renameSync(${JSON.stringify(tmp)},${JSON.stringify(target)});`,
    );
    await waitUntilAdvancing(api, 10, () => doc.getText().includes('v = 2') && trackedOf(api, key)?.source === 'external', 'the replaced file to be reloaded and seen as an external edit', 60_000);
    // the transient temp file is forgotten once its delete is seen
    await waitUntil(api, () => trackedOf(api, keyOf(tmp)) === undefined, 'the temporary file to be forgotten', 30_000);
    assert.equal(rowOf(api, keyOf(tmp)), undefined);
    assert.equal(must(rowOf(api, key)).badge, 'external');
    assert.equal(doc.isDirty, false);
    assert.deepEqual(logFor(api, (e) => e.key === key && e.decision === 'you'), [], 'never attributed to the user');
  });
});
