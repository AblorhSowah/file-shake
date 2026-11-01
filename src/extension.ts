import * as vscode from 'vscode';
import { ManualClock, ManualScheduler, systemClock, systemScheduler } from './core/clock';
import type { Clock, LogEntry, Scheduler, Snapshot, TrackedFile, ViewRow } from './core/types';
import { onDidChangeConfig, readConfig, toggleEnabled } from './vscode/config';
import { ShakeController } from './vscode/controller';
import { ShakeDecorationProvider } from './vscode/decorationProvider';
import { EditWatcher } from './vscode/editWatcher';
import { ShakeViewProvider } from './vscode/shakeViewProvider';
import { StatusBar } from './vscode/statusBar';
import { fileKeyFromUri, getRoots } from './vscode/uriKey';

export interface FileShakeApi {
  readonly apiVersion: 1;
  getRows(): readonly ViewRow[];
  getTracked(): readonly TrackedFile[];
  getSnapshot(): Snapshot;
  /** calls the decoration provider synchronously */
  getDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
  getStatusText(): string;
  getEventLog(): readonly LogEntry[];
  isEnabled(): boolean;
  /** fires after every model rebuild */
  readonly onDidUpdate: vscode.Event<void>;
  whenReferencesIdle(): Promise<void>;
  /** only defined when FILE_SHAKE_TEST=1: advance = clock + scheduler (ticks, debounces), then a refresh */
  readonly testing?: {
    advance(ms: number): void;
    overrideFocus(v: boolean | undefined): void;
    /** how often the view was resolved, posted `ready`, and was sent a snapshot */
    viewStats(): { resolved: number; ready: number; sent: number; visible: boolean };
    /** timers still pending on the (single, shared) ManualScheduler: tick chain, reference debounces, save/dirty-settle timers */
    pendingTimers(): number;
    /** same as the VS Code window gaining (true) or losing (false) focus; the real window state is ignored in test mode */
    windowFocusChanged(focused: boolean): void;
    /** same as clicking the row of `key` (a file key) in the File Shake view, just before the file opens */
    noteOpenedFromView(key: string): void;
  };
}

function readVersion(context: vscode.ExtensionContext): string {
  const pkg: unknown = context.extension.packageJSON;
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  return 'unknown';
}

export function activate(context: vscode.ExtensionContext): FileShakeApi {
  const subs = context.subscriptions;
  const testMode = process.env['FILE_SHAKE_TEST'] === '1';

  let clock: Clock = systemClock;
  let scheduler: Scheduler = systemScheduler;
  let manual: ManualScheduler | undefined;
  if (testMode) {
    const manualClock = new ManualClock(Date.now());
    manual = new ManualScheduler(manualClock);
    clock = manualClock;
    scheduler = manual;
  }
  let focusOverride: boolean | undefined;
  const isWindowFocused = (): boolean => focusOverride ?? (testMode ? true : vscode.window.state.focused);

  let config = readConfig();
  const getConfig = (): typeof config => config;

  const output = vscode.window.createOutputChannel('File Shake');
  subs.push(output);
  const log = (msg: string): void => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const decorations = new ShakeDecorationProvider();
  subs.push(decorations, vscode.window.registerFileDecorationProvider(decorations));

  const view = new ShakeViewProvider(context.extensionUri, log);
  subs.push(
    view,
    vscode.window.registerWebviewViewProvider(ShakeViewProvider.viewType, view, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  const status = new StatusBar();
  subs.push(status);

  const controller = new ShakeController({
    clock,
    scheduler,
    getConfig,
    getRoots,
    decorations,
    view,
    status,
    extensionVersion: readVersion(context),
    vscodeVersion: vscode.version,
    log,
  });
  subs.push(controller);

  const watcher = new EditWatcher({
    clock,
    scheduler,
    getConfig,
    getRoots,
    isWindowFocused,
    log: controller.eventLog,
    burst: controller.burst,
    sink: controller,
  });
  subs.push(watcher);

  subs.push(
    onDidChangeConfig(() => {
      config = readConfig();
      controller.applyConfig();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.onRootsChanged()),
    // "you" persist until you move to another file or leave the window
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      controller.onActiveEditorChanged(editor ? fileKeyFromUri(editor.document.uri) : undefined),
    ),
    // test mode runs on a fake clock and a pretend window focus; the real window state would make runs depend on the desktop
    ...(testMode ? [] : [vscode.window.onDidChangeWindowState((state) => controller.onWindowFocusChanged(state.focused))]),
    vscode.commands.registerCommand('fileShake.toggle', () => toggleEnabled()),
    vscode.commands.registerCommand('fileShake.clear', () => controller.clear()),
    vscode.commands.registerCommand('fileShake.focusView', () => vscode.commands.executeCommand('fileShake.view.focus')),
    vscode.commands.registerCommand('fileShake.showDebugInfo', () => {
      output.clear();
      output.appendLine(JSON.stringify(controller.getDebugInfo(), null, 2));
      output.show(true);
    }),
  );

  view.onOpenRow = (id) => controller.noteOpenedFromView(id);

  // publish the initial (empty) model: no file IO, no timers
  controller.refresh();

  const updates = new vscode.EventEmitter<void>();
  subs.push(updates, controller.onDidUpdate(() => updates.fire()));

  const api: FileShakeApi = {
    apiVersion: 1,
    getRows: () => controller.peekRows(),
    getTracked: () => controller.tracker.snapshot(),
    getSnapshot: () => controller.peekSnapshot(),
    getDecoration: (uri) => decorations.provideFileDecoration(uri),
    getStatusText: () => controller.getStatusText(),
    getEventLog: () => controller.eventLog.entries(),
    isEnabled: () => config.enable,
    onDidUpdate: updates.event,
    whenReferencesIdle: () => controller.references.whenIdle(),
    ...(manual
      ? {
          testing: {
            advance: (ms: number): void => {
              manual.advance(ms);
              controller.refresh();
            },
            overrideFocus: (v: boolean | undefined): void => {
              focusOverride = v;
            },
            viewStats: () => view.stats(),
            pendingTimers: (): number => manual.pending,
            windowFocusChanged: (focused: boolean): void => controller.onWindowFocusChanged(focused),
            noteOpenedFromView: (key: string): void => controller.noteOpenedFromView(key),
          },
        }
      : {}),
  };
  return api;
}

export function deactivate(): void {
  // everything is disposed through context.subscriptions
}
