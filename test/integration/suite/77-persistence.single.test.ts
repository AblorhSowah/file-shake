// Persistence and the two users, in real VS Code: rows stay until the same user moves on, "you" and "external" are
// separate users, files changed together stay together. Time is the fake clock (testing.advance), so "idle for a
// minute" costs nothing.
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import {
  createSettled,
  decorationOf,
  externalWrite,
  getApi,
  keyOf,
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
  workspaceDir,
} from './helpers';

suite('Persistence and the two users (single-root workspace)', () => {
  let api: FileShakeApi;
  const ws = workspaceDir();
  const created: string[] = [];

  suiteSetup(async function () {
    this.timeout(90_000);
    api = await getApi();
  });

  setup(async function () {
    this.timeout(60_000);
    await resetConfig(); // persistUntilNextFile is on by default: this suite tests the default
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

  const files = {
    'dep.ts': 'export const d = 1;\n',
    'a.ts': "import { d } from './dep';\nd();\n",
    'b.ts': 'export const b = 1;\n',
    'c.ts': 'export const c = 1;\n',
    'x.ts': 'export const x = 1;\n',
    'y.ts': 'export const y = 1;\n',
    'z.ts': 'export const z = 1;\n',
  };

  const gone = (key: string, what: string): Promise<void> => waitUntil(api, () => rowOf(api, key) === undefined, what, 30_000);

  test('the setting is on by default', () => {
    assert.equal(vscode.workspace.getConfiguration('fileShake').get('persistUntilNextFile'), true);
  });

  test('YOU: the file you typed in stays on screen, idle and not shaking, with its yellow references, long after you stop', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('persist-you'), files);
    const a = must(made['a.ts']);
    const dep = keyOf(must(made['dep.ts']));
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, dep)?.role === 'referenced', 'dep.ts to be referenced', 45_000);

    testing(api).advance(10 * 60_000); // ten minutes: far beyond idle + retain
    const row = must(rowOf(api, keyOf(a)), 'the typed file is still listed');
    assert.equal(row.phase, 'idle');
    assert.equal(row.intensity, 0, 'not shaking');
    assert.equal(row.actor, 'you');
    assert.equal(must(rowOf(api, dep), 'its yellow reference is still listed').phase, 'idle');
    assert.equal(rowOf(api, dep)?.actor, 'you');
    assert.ok(decorationOf(api, a), 'the Explorer still tints it');
    assert.ok(decorationOf(api, must(made['dep.ts'])), 'and the file it references');
    assert.match(api.getStatusText(), /a\.ts/, 'the status bar still names it');
  });

  test('YOU: switching to a different file removes the old file and its references; opening the new file adds nothing', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('switch-file'), files);
    const a = must(made['a.ts']);
    const dep = keyOf(must(made['dep.ts']));
    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await waitUntil(api, () => rowOf(api, dep) !== undefined, 'dep.ts to be referenced', 45_000);
    testing(api).advance(60_000);
    assert.ok(rowOf(api, keyOf(a)));

    await vscode.window.showTextDocument(await openDoc(must(made['b.ts'])), { preview: false });
    await gone(keyOf(a), 'the old file to go when you switch files');
    await gone(dep, 'the references of the old file to go with it');
    assert.equal(rowOf(api, keyOf(must(made['b.ts']))), undefined, 'merely opening a file is not activity');
    assert.equal(api.getRows().length, 0);
  });

  test('YOU: the new file comes when you type in it, and replaces the old one', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('type-new'), files);
    await typeAndWait(api, await openDoc(must(made['a.ts'])));
    testing(api).advance(60_000);
    await typeAndWait(api, await openDoc(must(made['b.ts'])));
    assert.equal(rowOf(api, keyOf(must(made['a.ts']))), undefined);
    const b = must(rowOf(api, keyOf(must(made['b.ts']))));
    assert.equal(b.actor, 'you');
    assert.equal(b.phase, 'active');
  });

  test('YOU: coming back to the file you were typing in keeps it', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('same-file'), files);
    const a = must(made['a.ts']);
    await typeAndWait(api, await openDoc(a));
    testing(api).advance(60_000);
    await vscode.window.showTextDocument(await openDoc(a), { preview: false });
    testing(api).advance(0);
    assert.ok(rowOf(api, keyOf(a)), 'still your file');
  });

  test('YOU: a file you switch away from while it is still shaking keeps shaking until it settles, then leaves', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('switch-active'), files);
    const a = keyOf(must(made['a.ts']));
    const b = keyOf(must(made['b.ts']));
    await typeAndWait(api, await openDoc(must(made['a.ts'])));
    testing(api).advance(500);
    await typeAndWait(api, await openDoc(must(made['b.ts'])));
    assert.equal(rowOf(api, a)?.phase, 'active', 'a is still shaking, so it is still shown next to b');
    assert.ok(rowOf(api, b));
    testing(api).advance(3000);
    assert.equal(rowOf(api, a), undefined, 'a settled and you had moved on');
    assert.equal(rowOf(api, b)?.phase, 'idle');
  });

  test('YOU: leaving the window removes your files once they are idle (and typing again brings the file back)', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('window'), files);
    const a = must(made['a.ts']);
    const doc = await openDoc(a);
    await typeAndWait(api, doc);
    testing(api).advance(60_000);
    assert.ok(rowOf(api, keyOf(a)));
    testing(api).windowFocusChanged(false);
    await gone(keyOf(a), 'your file to go when the window loses focus');
    await typeAndWait(api, doc);
    assert.equal(rowOf(api, keyOf(a))?.actor, 'you', 'typing again shows the file again');
  });

  test('YOU: clicking a row in the File Shake view is not "moving on"; opening a file any other way is', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('view-click'), files);
    const a = keyOf(must(made['a.ts']));
    await typeAndWait(api, await openDoc(must(made['a.ts'])));
    testing(api).advance(60_000);
    testing(api).noteOpenedFromView(keyOf(must(made['b.ts'])));
    await vscode.window.showTextDocument(await openDoc(must(made['b.ts'])), { preview: false });
    testing(api).advance(0);
    assert.ok(rowOf(api, a), 'opened from our own view: your file stays');
    await vscode.window.showTextDocument(await openDoc(must(made['c.ts'])), { preview: false });
    await gone(a, 'opening another file by hand releases your file');
  });

  test('EXTERNAL: a file changed from outside stays until the external writer changes a different file', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('external'), files);
    const x = keyOf(must(made['x.ts']));
    const y = keyOf(must(made['y.ts']));
    await externalWrite(must(made['x.ts']), 'export const x = 2;\n');
    await waitUntil(api, () => trackedOf(api, x)?.source === 'external', 'the external change to x.ts', 45_000);
    testing(api).advance(10 * 60_000);
    const row = must(rowOf(api, x), 'x.ts persists');
    assert.equal(row.actor, 'external');
    assert.equal(row.phase, 'idle');
    assert.ok(decorationOf(api, must(made['x.ts'])));

    await externalWrite(must(made['y.ts']), 'export const y = 2;\n');
    await waitUntil(api, () => trackedOf(api, y)?.source === 'external', 'the external change to y.ts', 45_000);
    testing(api).advance(0);
    assert.equal(rowOf(api, x), undefined, 'x.ts goes: the external writer moved on');
    assert.equal(rowOf(api, y)?.actor, 'external');
  });

  test('EXTERNAL: files changed at the same time are all shown, and stay together', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('external-together'), files);
    const x = must(made['x.ts']);
    const y = must(made['y.ts']);
    const z = must(made['z.ts']);
    await runNode(
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(x)},'//1\\n');fs.writeFileSync(${JSON.stringify(y)},'//1\\n');`,
    );
    await waitUntil(api, () => trackedOf(api, keyOf(x)) !== undefined && trackedOf(api, keyOf(y)) !== undefined, 'both files', 45_000);
    testing(api).advance(60_000);
    assert.ok(rowOf(api, keyOf(x)) && rowOf(api, keyOf(y)), 'both stay while the writer is quiet');
    await externalWrite(z, 'export const z = 2;\n');
    await waitUntil(api, () => trackedOf(api, keyOf(z)) !== undefined, 'the next external file', 45_000);
    testing(api).advance(0);
    assert.equal(rowOf(api, keyOf(x)), undefined);
    assert.equal(rowOf(api, keyOf(y)), undefined);
    assert.ok(rowOf(api, keyOf(z)));
  });

  test('TWO USERS: you and external are listed separately, and one moving on never removes the other\'s file', async function () {
    this.timeout(120_000);
    const made = await createSettled(api, scratch('two-users'), files);
    const a = must(made['a.ts']);
    const x = must(made['x.ts']);
    const y = must(made['y.ts']);
    const b = must(made['b.ts']);
    const dep = keyOf(must(made['dep.ts']));

    await typeAndWait(api, await openDoc(a));
    await settleRefs(api);
    await externalWrite(x, 'export const x = 2;\n');
    await waitUntil(api, () => trackedOf(api, keyOf(x))?.source === 'external', 'the external change to x.ts', 45_000);
    testing(api).advance(60_000);

    const rows = api.getSnapshot().rows;
    assert.equal(rows.find((r) => r.id === keyOf(a))?.actor, 'you');
    assert.equal(rows.find((r) => r.id === keyOf(x))?.actor, 'external');
    assert.equal(rows.find((r) => r.id === dep)?.actor, 'you', 'the yellow reference follows the user whose file imports it');

    await externalWrite(y, 'export const y = 2;\n'); // the external user moves on
    await waitUntil(api, () => trackedOf(api, keyOf(y)) !== undefined, 'the external change to y.ts', 45_000);
    testing(api).advance(0);
    assert.equal(rowOf(api, keyOf(x)), undefined);
    assert.ok(rowOf(api, keyOf(a)), 'your file is untouched by the other user moving on');
    assert.ok(rowOf(api, dep));

    await typeAndWait(api, await openDoc(b)); // you move on
    assert.equal(rowOf(api, keyOf(a)), undefined);
    assert.equal(rowOf(api, dep), undefined);
    assert.ok(rowOf(api, keyOf(y)), 'the external file is untouched by you moving on');
    assert.equal(rowOf(api, keyOf(y))?.actor, 'external');
  });

  test('turning persistUntilNextFile off makes idle rows expire by time again, live', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('toggle'), files);
    const a = keyOf(must(made['a.ts']));
    await typeAndWait(api, await openDoc(must(made['a.ts'])));
    testing(api).advance(60_000);
    assert.ok(rowOf(api, a), 'persisted');
    await setConfig('persistUntilNextFile', false);
    await waitUntil(api, () => rowOf(api, a) === undefined, 'the idle row to expire once persistence is off', 30_000);
    await waitUntil(api, () => testing(api).pendingTimers() === 0, 'no timers left', 10_000);
  });

  test('a persisted idle file costs no timers: nothing runs while nobody is typing', async function () {
    this.timeout(90_000);
    const made = await createSettled(api, scratch('no-timers'), files);
    await typeAndWait(api, await openDoc(must(made['a.ts'])));
    await settleRefs(api);
    testing(api).advance(60_000);
    assert.equal(testing(api).pendingTimers(), 0, 'the tick chain stops once everything is idle, even though the rows stay');
  });
});
