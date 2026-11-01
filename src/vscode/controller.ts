import type * as vscode from 'vscode';
import { ActivityTracker } from '../core/activityTracker';
import { BurstGuard } from '../core/burstGuard';
import { toTrackerOptions } from '../core/config';
import type { FileShakeConfig } from '../core/config';
import { K } from '../core/constants';
import { buildDecorations } from '../core/decorations';
import { EventLog } from '../core/eventLog';
import { buildStatus } from '../core/statusText';
import type {
  Clock,
  DecorationSpec,
  EditSource,
  FileKey,
  LogEntry,
  Scheduler,
  Snapshot,
  TrackedFile,
  ViewRow,
  WorkspaceRoot,
} from '../core/types';
import { buildRows } from '../core/viewModel';
import { ReferenceService } from './referenceService';
import { uriFromKey } from './uriKey';

export interface DecorationSink {
  update(next: Map<FileKey, DecorationSpec>): void;
}

export interface ViewSink {
  push(snapshot: Snapshot): void;
  isVisible(): boolean;
}

export interface StatusSink {
  update(status: { text: string; tooltip: string }, visible: boolean): void;
}

export interface ControllerDeps {
  clock: Clock;
  scheduler: Scheduler;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  decorations: DecorationSink;
  view: ViewSink;
  status: StatusSink;
  extensionVersion: string;
  vscodeVersion: string;
  log(msg: string): void;
}

export interface DebugInfo {
  extensionVersion: string;
  vscodeVersion: string;
  config: FileShakeConfig;
  roots: WorkspaceRoot[];
  enabled: boolean;
  viewVisible: boolean;
  seq: number;
  tracked: TrackedFile[];
  rows: ViewRow[];
  references: Array<{
    source: FileKey;
    targets: Array<{ key: FileKey; count: number }>;
    unresolved: number;
    truncated: boolean;
    skipped: string | undefined;
    parseMs: number;
  }>;
  recentEvents: readonly LogEntry[];
}

/** Owns the model: tracker + reference service -> rows -> decorations / status bar / view. */
export class ShakeController implements vscode.Disposable {
  readonly tracker: ActivityTracker;
  readonly references: ReferenceService;
  readonly eventLog = new EventLog(K.EVENT_LOG_SIZE);
  readonly burst: BurstGuard;

  private rows: ViewRow[] = [];
  private snapshot: Snapshot;
  private statusText = '';
  private seq = 0;
  private tick: { cancel(): void } | undefined;
  private readonly sources = new Map<FileKey, EditSource>();
  private lastPushed = '';
  private readonly listeners = new Set<() => void>();
  private analysisKey = '';
  private disposed = false;
  private readonly refSub: vscode.Disposable;

  constructor(private readonly deps: ControllerDeps) {
    const cfg = deps.getConfig();
    this.tracker = new ActivityTracker(deps.clock, toTrackerOptions(cfg));
    this.burst = new BurstGuard(deps.clock);
    this.references = new ReferenceService({
      scheduler: deps.scheduler,
      clock: deps.clock,
      getConfig: deps.getConfig,
      getRoots: deps.getRoots,
      log: deps.log,
    });
    this.refSub = this.references.onDidChange(() => this.refresh());
    this.analysisKey = this.analysisSettings(cfg);
    this.snapshot = this.buildSnapshot(cfg, []);
  }

  /** Registers a callback fired after every model rebuild. */
  onDidUpdate(cb: () => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  /** Records an edit. Returns false when the tracker ignored it (bad weight, external duplicate, disabled). */
  onActivity(key: FileKey, source: EditSource, weight: number): boolean {
    if (this.disposed || !this.deps.getConfig().enable) return false;
    if (!this.tracker.record({ key, source, weight })) return false;
    this.references.request(key);
    // first sight of a file, or a source flip, is shown at once; plain repeats wait for the next tick
    const changed = this.sources.get(key) !== source;
    this.sources.set(key, source);
    if (changed || this.tick === undefined) this.refresh();
    this.ensureTick();
    return true;
  }

  onDeleted(key: FileKey): void {
    this.tracker.forgetUnder(key);
    this.sources.delete(key);
    this.rerequest(this.references.invalidate(key));
    this.refresh();
  }

  /** Returns true when tracked state moved to the new name (so the rename's disk echo is not a new edit). */
  onRenamed(oldKey: FileKey, newKey: FileKey): boolean {
    const moved = this.tracker.renameUnder(oldKey, newKey) > 0;
    this.sources.delete(oldKey);
    this.references.invalidateAll();
    this.rerequestShown();
    this.refresh();
    return moved;
  }

  /** A tsconfig/jsconfig/go.mod/composer.json changed: resolution inputs are stale. */
  onProjectFileChanged(): void {
    this.references.invalidateAll();
    this.rerequestShown();
  }

  /** Re-applies settings (live, no restart). */
  applyConfig(): void {
    const cfg = this.deps.getConfig();
    this.tracker.setOptions(toTrackerOptions(cfg));
    if (!cfg.enable) {
      this.tracker.clear();
      this.sources.clear();
      this.references.invalidateAll();
    } else {
      const key = this.analysisSettings(cfg);
      if (key !== this.analysisKey) {
        this.references.invalidateAll();
        this.rerequestShown();
      }
    }
    this.analysisKey = this.analysisSettings(cfg);
    this.refresh();
    if (this.needsTick()) this.ensureTick();
  }

  clear(): void {
    this.tracker.clear();
    this.sources.clear();
    this.references.invalidateAll();
    this.refresh();
  }

  /** Workspace folders changed: display paths and resolution roots differ. */
  onRootsChanged(): void {
    this.references.invalidateAll();
    this.rerequestShown();
    this.refresh();
  }

  /** Recomputes rows, decorations, status bar and view immediately. */
  refresh(): void {
    if (this.disposed) return;
    const cfg = this.deps.getConfig();
    const tracked = cfg.enable ? this.tracker.snapshot() : [];
    this.rows = this.computeRows(cfg, tracked);
    const decorations = cfg.enable
      ? buildDecorations(this.rows, { showWhenIdle: cfg.showWhenIdle, decorateFolders: cfg.decorateFolders })
      : new Map<FileKey, DecorationSpec>();
    this.deps.decorations.update(decorations);

    const status = buildStatus({ enabled: cfg.enable, rows: this.rows, showWhenIdle: cfg.showWhenIdle });
    this.statusText = status.text;
    this.deps.status.update(status, cfg.showStatusBar);

    this.seq += 1;
    this.snapshot = this.buildSnapshot(cfg, this.rows);
    const signature = JSON.stringify({ ...this.snapshot, seq: 0 });
    if (signature !== this.lastPushed) {
      this.lastPushed = signature;
      this.deps.view.push(this.snapshot);
    }
    for (const cb of [...this.listeners]) cb();
  }

  /** Fresh rows without side effects (used by the test API). */
  peekRows(): readonly ViewRow[] {
    const cfg = this.deps.getConfig();
    return cfg.enable ? this.computeRows(cfg, this.tracker.snapshot()) : [];
  }

  peekSnapshot(): Snapshot {
    const cfg = this.deps.getConfig();
    return this.buildSnapshot(cfg, this.peekRows());
  }

  getStatusText(): string {
    return this.statusText;
  }

  getDebugInfo(): DebugInfo {
    const cfg = this.deps.getConfig();
    return {
      extensionVersion: this.deps.extensionVersion,
      vscodeVersion: this.deps.vscodeVersion,
      config: cfg,
      roots: this.deps.getRoots(),
      enabled: cfg.enable,
      viewVisible: this.deps.view.isVisible(),
      seq: this.seq,
      tracked: this.tracker.snapshot(),
      rows: this.rows,
      references: [...this.references.results()].map(([source, r]) => ({
        source,
        targets: r.targets.map((t) => ({ key: t.key, count: t.count })),
        unresolved: r.unresolved,
        truncated: r.truncated,
        skipped: r.skipped,
        parseMs: r.parseMs,
      })),
      recentEvents: this.eventLog.entries(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tick?.cancel();
    this.tick = undefined;
    this.refSub.dispose();
    this.references.dispose();
    this.listeners.clear();
  }

  // ----------------------------------------------------------------------------

  private analysisSettings(cfg: FileShakeConfig): string {
    return `${cfg.maxFileSizeKb}|${JSON.stringify(cfg.excludeGlobs)}`;
  }

  private computeRows(cfg: FileShakeConfig, tracked: readonly TrackedFile[]): ViewRow[] {
    return buildRows({
      tracked,
      references: this.references.results(),
      roots: this.deps.getRoots(),
      toUri: (key) => uriFromKey(key).toString(),
      sensitivity: cfg.sensitivity,
      maxFiles: cfg.maxFiles,
      showWhenIdle: cfg.showWhenIdle,
    });
  }

  private buildSnapshot(cfg: FileShakeConfig, rows: readonly ViewRow[]): Snapshot {
    return {
      v: 1,
      seq: this.seq,
      enabled: cfg.enable,
      animate: cfg.enableAnimation,
      colors: { edited: cfg.editedColor, referenced: cfg.referencedColor },
      rows: [...rows],
    };
  }

  /** Sources whose references are on screen: active files, plus idle ones while `showWhenIdle` keeps them listed. */
  private shownSources(): Set<FileKey> {
    const keepIdle = this.deps.getConfig().showWhenIdle;
    return new Set(this.tracker.snapshot().filter((t) => keepIdle || t.phase === 'active').map((t) => t.key));
  }

  private rerequestShown(): void {
    for (const k of this.shownSources()) this.references.request(k);
  }

  private rerequest(keys: readonly FileKey[]): void {
    const shown = this.shownSources();
    for (const k of keys) if (shown.has(k)) this.references.request(k);
  }

  /** Timer chain that runs only while something is active or waiting to be removed: zero timers when idle. */
  private ensureTick(): void {
    if (this.tick !== undefined || this.disposed) return;
    this.tick = this.deps.scheduler.setTimeout(() => {
      this.tick = undefined;
      if (this.disposed) return;
      this.refresh();
      if (this.needsTick()) this.ensureTick();
    }, K.TICK_MS);
  }

  private needsTick(): boolean {
    const cfg = this.deps.getConfig();
    if (!cfg.enable || this.tracker.size === 0) return false;
    if (!cfg.showWhenIdle) return true; // idle files are still waiting to be removed
    return this.tracker.snapshot().some((t) => t.phase === 'active');
  }
}
