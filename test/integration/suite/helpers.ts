// Shared helpers for the integration suites. Runs inside VS Code's extension host (bundled by
// esbuild with `vscode` and `mocha` external). Synchronisation is event/state based: the model is
// driven by the extension's ManualClock/ManualScheduler through api.testing, and real asynchrony
// (file watchers, reference analysis) is awaited with a bounded poll that re-reads state, never a
// fixed sleep.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileShakeApi } from '../../../src/extension';
import type { LogEntry, TrackedFile, ViewRow } from '../../../src/core/types';
import { normalizePath } from '../../../src/core/pathUtils';
import { K } from '../../../src/core/constants';

export const EXT_ID = 'file-shake.file-shake';
export type TestingApi = NonNullable<FileShakeApi['testing']>;

let cachedApi: FileShakeApi | undefined;

export async function getApi(): Promise<FileShakeApi> {
  if (cachedApi) return cachedApi;
  const ext = vscode.extensions.getExtension<FileShakeApi>(EXT_ID);
  if (!ext) throw new Error(`extension ${EXT_ID} is not installed in the test host`);
  const api = await ext.activate();
  if (!api || api.apiVersion !== 1) throw new Error('extension did not return the FileShakeApi');
  cachedApi = api;
  return api;
}

export function testing(api: FileShakeApi): TestingApi {
  if (!api.testing) throw new Error('api.testing is undefined: FILE_SHAKE_TEST=1 must be set in the launch environment');
  return api.testing;
}

/** FileKey of a file-system path. */
export const keyOf = (fsPath: string): string => normalizePath(fsPath);

export function envPath(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (launched without the runTest.ts harness?)`);
  return v;
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function nextUpdate(api: FileShakeApi): Promise<void> {
  return new Promise<void>((resolve) => {
    const sub = api.onDidUpdate(() => {
      sub.dispose();
      resolve();
    });
  });
}

/**
 * Waits until `cond()` holds. Each round refreshes the model (api.testing.advance(0): clock does not move) and
 * then waits for the next model update or a short real-time tick, so real file-watcher latency is tolerated
 * without a fixed sleep. Throws with `what` on timeout.
 */
export async function waitUntil(api: FileShakeApi, cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    testing(api).advance(0);
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await Promise.race([delay(40), nextUpdate(api)]);
  }
}

/**
 * Run a debounce window, let the reference analysis finish, refresh. Real file-system events can schedule a NEW
 * debounce while we are waiting (the fake scheduler only fires it when advanced), so wait in bounded slices and
 * advance again if the service is not idle yet.
 */
export async function settleRefs(api: FileShakeApi): Promise<void> {
  const t = testing(api);
  for (let i = 0; i < 20; i++) {
    t.advance(K.REF_DEBOUNCE_MS + 1);
    const idle = await Promise.race([api.whenReferencesIdle().then(() => true), delay(150).then(() => false)]);
    if (idle) break;
  }
  t.advance(0);
}

export const rowOf = (api: FileShakeApi, key: string): ViewRow | undefined => api.getRows().find((r) => r.id === key);
export const trackedOf = (api: FileShakeApi, key: string): TrackedFile | undefined => api.getTracked().find((t) => t.key === key);
export const logFor = (api: FileShakeApi, pred: (e: LogEntry) => boolean): LogEntry[] => api.getEventLog().filter(pred);

export function uriOfKey(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath);
}

export async function openDoc(fsPath: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
}

/** Types `text` at the end of the document in the (newly focused) editor, like a user would. */
export async function typeInto(doc: vscode.TextDocument, text = ' '): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  const ok = await editor.edit((b) => b.insert(end, text));
  if (!ok) throw new Error('TextEditor.edit was rejected');
  return editor;
}

export async function revertDirtyDocuments(): Promise<void> {
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty) {
      await vscode.window.showTextDocument(d, { preview: false });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
}

/** Puts the extension, the editors and the fake clock back to a neutral state between tests. */
export async function resetState(api: FileShakeApi): Promise<void> {
  await revertDirtyDocuments();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  testing(api).overrideFocus(undefined);
  await vscode.commands.executeCommand('fileShake.clear');
  testing(api).advance(60_000);
  await api.whenReferencesIdle();
  testing(api).advance(0);
}

export async function setConfig(name: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('fileShake').update(name, value, vscode.ConfigurationTarget.Global);
}

export async function resetConfig(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  const pkg = ext?.packageJSON as { contributes?: { configuration?: { properties?: Record<string, unknown> } } } | undefined;
  const names = Object.keys(pkg?.contributes?.configuration?.properties ?? {}).map((k) => k.replace(/^fileShake\./, ''));
  const cfg = vscode.workspace.getConfiguration('fileShake');
  for (const n of names) {
    if (cfg.inspect(n)?.globalValue !== undefined) await cfg.update(n, undefined, vscode.ConfigurationTarget.Global);
  }
}

/** Creates (or overwrites) a file under `base`, making directories as needed. */
export function writeFile(base: string, rel: string, content: string): string {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function removePath(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** A fresh, uniquely named scratch directory inside `base` (so tests never touch each other's files). */
let scratchCounter = 0;
export function scratchDir(base: string, label: string): string {
  scratchCounter += 1;
  const dir = join(base, `scratch-${label}-${scratchCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspaceDir(): string {
  return envPath('FS_TEST_WORKSPACE');
}

export function decorationOf(api: FileShakeApi, fsPath: string): vscode.FileDecoration | undefined {
  return api.getDecoration(vscode.Uri.file(fsPath));
}

export function colorIdOf(d: vscode.FileDecoration | undefined): string | undefined {
  // ThemeColor.id exists at runtime but is not part of the public typings
  return d?.color instanceof vscode.ThemeColor ? (d.color as unknown as { id?: string }).id : undefined;
}

export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
  return value;
}

/**
 * Like waitUntil, but moves the fake clock forward by `stepMs` each round (for flows that depend on timers,
 * e.g. the short settle delay for a clean-after-change document event).
 */
export async function waitUntilAdvancing(api: FileShakeApi, stepMs: number, cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    testing(api).advance(stepMs);
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await Promise.race([delay(40), nextUpdate(api)]);
  }
}

/**
 * Types into `doc` and waits until the extension has actually recorded that edit (editCount grew) before
 * returning, so the fake clock can safely be advanced afterwards. VS Code reports the first edit of a clean
 * document and its dirty-state change as two events; waiting here keeps the fake clock from racing them.
 */
export async function typeAndWait(api: FileShakeApi, doc: vscode.TextDocument, text = ' '): Promise<TrackedFile> {
  const key = keyOf(doc.uri.fsPath);
  const before = trackedOf(api, key)?.editCount ?? 0;
  await typeInto(doc, text);
  await waitUntil(api, () => (trackedOf(api, key)?.editCount ?? 0) > before, `edit #${before + 1} of ${key} to be recorded`);
  return must(trackedOf(api, key), `tracked entry for ${key}`);
}

/**
 * Runs `node -e <code>` in a SEPARATE process (the extension host's own binary in ELECTRON_RUN_AS_NODE mode), so a
 * file written this way is a genuine external edit: it does not come from the test process or the editor.
 */
export function runNode(code: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited with ${String(c)}: ${err}`))));
  });
}

/** Writes `content` to `file` from a separate process. */
export function externalWrite(file: string, content: string): Promise<void> {
  return runNode(`require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})`);
}

/**
 * Creates files on disk, waits until the watcher has reported all of them, then resets the model, so the test starts
 * with files that exist but are not "recently edited" (otherwise green would win over yellow).
 */
export async function createSettled(api: FileShakeApi, base: string, files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) out[rel] = writeFile(base, rel, content);
  const keys = Object.values(out).map(keyOf);
  await waitUntil(api, () => keys.every((k) => trackedOf(api, k) !== undefined), 'the watcher to report every created file', 60_000);
  await resetState(api);
  return out;
}

/** Real-time wait (system clock, no seam): polls `cond` every 25 ms until it holds or `timeoutMs` passes. */
export async function waitReal(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms (real time) waiting for: ${what}`);
    await delay(25);
  }
}
