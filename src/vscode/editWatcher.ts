import * as vscode from 'vscode';
import { K } from '../core/constants';
import type { BurstGuard } from '../core/burstGuard';
import type { FileShakeConfig } from '../core/config';
import type { EventLog } from '../core/eventLog';
import { createExcludeMatcher, relativeForMatch } from '../core/glob';
import { typingWeight } from '../core/intensity';
import type { ContentChangeSize } from '../core/intensity';
import { basename, isUnder } from '../core/pathUtils';
import { classifyDocumentChange, classifyWatcherEvent } from '../core/sourceClassifier';
import type { Classification } from '../core/sourceClassifier';
import type { ClassifyReason, Clock, EditSource, FileKey, LogEntry, Scheduler, WorkspaceRoot } from '../core/types';
import { fileKeyFromUri } from './uriKey';

/** Receives accepted activity. Implemented by the controller. */
export interface ActivitySink {
  /** false = the tracker ignored it (e.g. an external duplicate) */
  onActivity(key: FileKey, source: EditSource, weight: number): boolean;
  onDeleted(key: FileKey): void;
  /** true = tracked state moved to the new name */
  onRenamed(oldKey: FileKey, newKey: FileKey): boolean;
  onProjectFileChanged(): void;
}

export interface EditWatcherDeps {
  clock: Clock;
  scheduler: Scheduler;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  isWindowFocused(): boolean;
  log: EventLog;
  burst: BurstGuard;
  sink: ActivitySink;
}

const SAVE_SAFETY_MS = 5000;
/** How long a clean-after-change event waits for the dirty-state event that follows a real edit. */
const DIRTY_SETTLE_MS = 150;
const MAX_SAVE_ENTRIES = 200;
const PROJECT_FILES = new Set(['tsconfig.json', 'jsconfig.json', 'go.mod', 'composer.json']);

interface DocChange {
  key: FileKey;
  at: number;
  count: number;
  sizes: ContentChangeSize[];
  reason: 'undo' | 'redo' | undefined;
  isSaving: boolean;
  isActiveEditorDoc: boolean;
  windowFocused: boolean;
}

/** Turns VS Code document and file-system events into classified activity (DESIGN 9). */
export class EditWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private readonly saving = new Map<FileKey, { cancel(): void }>();
  private readonly lastSaveAt = new Map<FileKey, number>();
  /** Destinations of workbench renames that moved tracked state: their file-system echo is not an external edit. */
  private recentMoves: Array<{ key: FileKey; at: number }> = [];
  private readonly pendingClean = new Map<FileKey, { change: DocChange; timer: { cancel(): void } }>();
  private matcher: { key: string; fn: (rel: string) => boolean } | undefined;
  private disposed = false;

  constructor(private readonly deps: EditWatcherDeps) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDidSave(doc)),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          const from = fileKeyFromUri(f.oldUri);
          const to = fileKeyFromUri(f.newUri);
          if (from !== undefined && to !== undefined) {
            if (this.deps.sink.onRenamed(from, to)) this.noteMove(to);
          }
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuildWatchers()),
    );
    this.rebuildWatchers();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.saving.values()) t.cancel();
    this.saving.clear();
    for (const p of this.pendingClean.values()) p.timer.cancel();
    this.pendingClean.clear();
    this.lastSaveAt.clear();
    this.recentMoves = [];
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // ---- documents -------------------------------------------------------------

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.disposed) return;
    const now = this.deps.clock.now();
    const doc = e.document;
    const key = fileKeyFromUri(doc.uri);
    const cfg = this.deps.getConfig();
    const record = (decision: LogEntry['decision'], reason: ClassifyReason, weight = 0): void =>
      this.deps.log.add({ at: now, key: key ?? doc.uri.toString(), origin: 'doc', decision, reason, weight });

    if (!cfg.enable) return record('ignore', 'disabled');
    if (key === undefined) return record('ignore', 'scheme');
    if (this.isExcluded(key)) return record('ignore', 'excluded');

    if (e.contentChanges.length === 0) {
      // The dirty flag of a clean document flips in a separate event right after its first edit.
      const pending = this.pendingClean.get(key);
      if (pending && doc.isDirty) {
        this.settlePending(key, true);
        return;
      }
      return record('ignore', 'no-content-change');
    }
    // another content change while one is still waiting for its dirty flag: that one was a reload
    this.settlePending(key, false);

    const change: DocChange = {
      key,
      at: now,
      count: e.contentChanges.length,
      sizes: e.contentChanges.map((c) => ({ inserted: c.text.length, deleted: c.rangeLength })),
      reason:
        e.reason === vscode.TextDocumentChangeReason.Undo
          ? 'undo'
          : e.reason === vscode.TextDocumentChangeReason.Redo
            ? 'redo'
            : undefined,
      isSaving: this.saving.has(key),
      isActiveEditorDoc: doc === vscode.window.activeTextEditor?.document,
      windowFocused: this.deps.isWindowFocused(),
    };

    // VS Code reports the first edit of a clean document while `isDirty` is still false, then fires a
    // separate dirty-state event. A reload from disk never gets that second event, so wait briefly
    // before calling a clean-after-change event a reload (see DESIGN Deviations).
    if (!doc.isDirty && !change.isSaving && change.reason === undefined) {
      const timer = this.deps.scheduler.setTimeout(() => this.settlePending(key, false), DIRTY_SETTLE_MS);
      this.pendingClean.set(key, { change, timer });
      return;
    }
    this.classifyDoc(change, doc.isDirty);
  }

  /** Resolves a clean-after-change event once we know whether the document became dirty. */
  private settlePending(key: FileKey, dirty: boolean): void {
    const pending = this.pendingClean.get(key);
    if (!pending) return;
    this.pendingClean.delete(key);
    pending.timer.cancel();
    if (this.disposed) return;
    this.classifyDoc(pending.change, dirty);
  }

  private classifyDoc(c: DocChange, isDirtyAfter: boolean): void {
    const cfg = this.deps.getConfig();
    const cls = classifyDocumentChange({
      contentChangeCount: c.count,
      isSaving: c.isSaving,
      reason: c.reason,
      isDirtyAfter,
      isActiveEditorDoc: c.isActiveEditorDoc,
      windowFocused: c.windowFocused,
    });
    // A checkout that rewrites files whose documents are open reaches us as reloads: the same flood as on disk.
    if (cls.decision === 'external' && !this.deps.burst.accept(c.key)) {
      this.deps.log.add({ at: c.at, key: c.key, origin: 'doc', decision: 'ignore', reason: 'burst', weight: 0 });
      return;
    }
    this.accept(c.key, cls, cfg, 'doc', c.at, () =>
      cls.decision === 'you' ? typingWeight(c.sizes) : K.EXTERNAL_EVENT_WEIGHT,
    );
  }

  private onWillSave(doc: vscode.TextDocument): void {
    const key = fileKeyFromUri(doc.uri);
    if (key === undefined || this.disposed) return;
    this.saving.get(key)?.cancel();
    // safety net: if did-save never arrives, edits must not stay classified as "saving" forever
    this.saving.set(
      key,
      this.deps.scheduler.setTimeout(() => this.saving.delete(key), SAVE_SAFETY_MS),
    );
  }

  private onDidSave(doc: vscode.TextDocument): void {
    const key = fileKeyFromUri(doc.uri);
    if (key === undefined || this.disposed) return;
    this.saving.get(key)?.cancel();
    this.saving.delete(key);
    this.lastSaveAt.delete(key);
    this.lastSaveAt.set(key, this.deps.clock.now());
    while (this.lastSaveAt.size > MAX_SAVE_ENTRIES) {
      const oldest = this.lastSaveAt.keys().next();
      if (oldest.done) break;
      this.lastSaveAt.delete(oldest.value);
    }
  }

  // ---- disk ------------------------------------------------------------------

  private noteMove(to: FileKey): void {
    const now = this.deps.clock.now();
    this.recentMoves = this.recentMoves.filter((m) => now - m.at < K.SELF_SAVE_WINDOW_MS);
    this.recentMoves.push({ key: to, at: now });
    if (this.recentMoves.length > MAX_SAVE_ENTRIES) this.recentMoves.splice(0, this.recentMoves.length - MAX_SAVE_ENTRIES);
  }

  /** When VS Code itself last wrote `key`: a save of the file, or a rename of it or of a folder above it. */
  private lastOwnWriteAt(key: FileKey, now: number): number | undefined {
    let latest = this.lastSaveAt.get(key);
    for (const m of this.recentMoves) {
      if (now - m.at < K.SELF_SAVE_WINDOW_MS && isUnder(m.key, key) && (latest === undefined || m.at > latest)) latest = m.at;
    }
    return latest;
  }

  private rebuildWatchers(): void {
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    if (this.disposed) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      watcher.onDidChange((uri) => this.onDisk(uri, false));
      watcher.onDidCreate((uri) => this.onDisk(uri, true));
      watcher.onDidDelete((uri) => {
        const key = fileKeyFromUri(uri);
        if (key === undefined || this.disposed || !this.deps.getConfig().enable) return;
        this.deps.sink.onDeleted(key);
        if (PROJECT_FILES.has(basename(key))) this.deps.sink.onProjectFileChanged();
      });
      this.fileWatchers.push(watcher);
    }
  }

  private onDisk(uri: vscode.Uri, created: boolean): void {
    if (this.disposed) return;
    const key = fileKeyFromUri(uri);
    if (key !== undefined && this.deps.getConfig().enable && PROJECT_FILES.has(basename(key))) {
      this.deps.sink.onProjectFileChanged();
    }
    if (!created) {
      this.handleDisk(uri);
      return;
    }
    // directory creations are not file activity
    Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      (stat) => {
        if ((stat.type & vscode.FileType.Directory) === 0) this.handleDisk(uri);
      },
      () => undefined,
    );
  }

  private handleDisk(uri: vscode.Uri): void {
    if (this.disposed) return;
    const now = this.deps.clock.now();
    const key = fileKeyFromUri(uri);
    const cfg = this.deps.getConfig();
    const record = (decision: LogEntry['decision'], reason: ClassifyReason, weight = 0): void =>
      this.deps.log.add({ at: now, key: key ?? uri.toString(), origin: 'watcher', decision, reason, weight });

    if (!cfg.enable) return record('ignore', 'disabled');
    if (key === undefined) return record('ignore', 'scheme');
    if (this.isExcluded(key)) return record('ignore', 'excluded');
    if (!this.deps.burst.accept(key)) return record('ignore', 'burst');

    const saved = this.lastOwnWriteAt(key, now);
    const cls = classifyWatcherEvent({ msSinceOwnSave: saved === undefined ? undefined : now - saved });
    if (cls.decision === 'ignore') return record('ignore', cls.reason);
    this.accept(key, cls, cfg, 'watcher', now, () => K.EXTERNAL_EVENT_WEIGHT);
  }

  // ---- shared ----------------------------------------------------------------

  private accept(
    key: FileKey,
    cls: Classification,
    cfg: FileShakeConfig,
    origin: LogEntry['origin'],
    at: number,
    weightOf: () => number,
  ): void {
    const record = (decision: LogEntry['decision'], reason: ClassifyReason, weight = 0): void =>
      this.deps.log.add({ at, key, origin, decision, reason, weight });
    if (cls.decision === 'ignore') return record('ignore', cls.reason);
    if (cls.decision === 'external' && !cfg.detectExternalEdits) return record('ignore', 'external-detection-off');
    const source: EditSource = cls.decision;
    const weight = weightOf();
    if (!(weight > 0)) return record('ignore', 'no-content-change');
    if (this.deps.sink.onActivity(key, source, weight)) record(source, cls.reason, weight);
    else record('ignore', 'dedupe', weight);
  }

  private isExcluded(key: FileKey): boolean {
    const cfg = this.deps.getConfig();
    const id = JSON.stringify(cfg.excludeGlobs);
    if (this.matcher?.key !== id) {
      this.matcher = { key: id, fn: createExcludeMatcher(cfg.excludeGlobs, { nocase: process.platform === 'win32' }) };
    }
    return this.matcher.fn(relativeForMatch(key, this.deps.getRoots()));
  }
}
