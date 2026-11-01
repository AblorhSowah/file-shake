// Workspace folders added and removed while the extension is running (watchers are rebuilt, display roots change).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { FileShakeApi } from '../../../src/extension';
import { envPath, getApi, keyOf, must, openDoc, resetConfig, resetState, rowOf, settleRefs, testing, trackedOf, typeAndWait, waitUntil } from './helpers';

suite('Workspace folders added and removed at runtime (multi-root)', () => {
  let api: FileShakeApi;

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
  });

  function foldersChanged(): Promise<void> {
    return new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        sub.dispose();
        resolve();
      });
    });
  }

  test('a folder added at runtime is watched (external writes show up) and displayed under its own name; removing it is harmless', async function () {
    this.timeout(120_000);
    const gamma = join(envPath('FS_TEST_ROOT'), 'gamma');
    mkdirSync(gamma, { recursive: true });
    writeFileSync(join(gamma, 'g.ts'), "import { x } from '../multi/beta/lib';\nexport const g = x;\n");
    try {
      const added = foldersChanged();
      assert.equal(vscode.workspace.updateWorkspaceFolders(2, 0, { uri: vscode.Uri.file(gamma), name: 'gamma' }), true);
      await added;
      assert.deepEqual((vscode.workspace.workspaceFolders ?? []).map((f) => f.name), ['alpha', 'beta', 'gamma']);

      // the new folder has a watcher: a write from outside is seen
      const fresh = join(gamma, 'fresh.ts');
      writeFileSync(fresh, 'export const fresh = 1;\n');
      // VS Code starts watching a freshly added folder asynchronously; a write made before that is never reported.
      // Keep rewriting until the watcher is live; the attempt number says how long that took.
      let attempts = 1;
      const rewrite = setInterval(() => writeFileSync(fresh, `export const fresh = ${++attempts};\n`), 500);
      try {
        await waitUntil(api, () => trackedOf(api, keyOf(fresh)) !== undefined, 'an external row for a file in the NEW folder', 30_000);
      } finally {
        clearInterval(rewrite);
      }
      assert.deepEqual(must(rowOf(api, keyOf(fresh))).folderPath, ['gamma']);

      // typing there works and its imports resolve across roots
      const g = join(gamma, 'g.ts');
      await typeAndWait(api, await openDoc(g));
      await settleRefs(api);
      await waitUntil(api, () => rowOf(api, keyOf(join(envPath('FS_TEST_BETA'), 'lib.ts'))) !== undefined, 'beta/lib.ts to be referenced from the new folder', 45_000);
      assert.deepEqual(must(rowOf(api, keyOf(g))).folderPath, ['gamma']);

      // the pre-existing roots keep their names
      await typeAndWait(api, await openDoc(join(envPath('FS_TEST_ALPHA'), 'shared.ts')));
      assert.deepEqual(must(rowOf(api, keyOf(join(envPath('FS_TEST_ALPHA'), 'shared.ts')))).folderPath, ['alpha']);

      // remove it again
      await resetState(api);
      const removed = foldersChanged();
      assert.equal(vscode.workspace.updateWorkspaceFolders(2, 1), true);
      await removed;
      assert.deepEqual((vscode.workspace.workspaceFolders ?? []).map((f) => f.name), ['alpha', 'beta']);
      // the extension still works, the old folder is no longer watched
      const after = join(envPath('FS_TEST_ALPHA'), 'only-alpha.ts');
      await typeAndWait(api, await openDoc(after));
      assert.equal(must(rowOf(api, keyOf(after))).role, 'edited');
      const orphan = join(gamma, 'orphan.ts');
      writeFileSync(orphan, 'export {};\n');
      // an unwatched folder produces no event; prove the pipeline is idle, not slow, by pushing a watched write through afterwards
      const probe = join(envPath('FS_TEST_BETA'), 'probe.ts');
      writeFileSync(probe, 'export {};\n');
      await waitUntil(api, () => trackedOf(api, keyOf(probe)) !== undefined, 'the probe write in a still-watched folder', 60_000);
      assert.equal(trackedOf(api, keyOf(orphan)), undefined, 'the removed folder is no longer watched');
    } finally {
      rmSync(gamma, { recursive: true, force: true });
      rmSync(join(envPath('FS_TEST_BETA'), 'probe.ts'), { force: true });
    }
  });
});
