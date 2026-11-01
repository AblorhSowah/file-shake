import * as vscode from 'vscode';
import type { FileShakeConfig } from '../core/config';
import { K } from '../core/constants';
import { createExcludeMatcher, relativeForMatch } from '../core/glob';
import { dirname, isUnder } from '../core/pathUtils';
import { analyzeReferences, detectLanguage, loadProjectInfo } from '../core/references';
import type { Clock, FileKey, ProbeFs, ProjectInfo, ReferenceResult, Scheduler, WorkspaceRoot } from '../core/types';
import { fileKeyFromUri, uriFromKey } from './uriKey';

const CACHE_LIMIT = 50;

export interface ReferenceServiceDeps {
  scheduler: Scheduler;
  clock: Clock;
  getConfig(): FileShakeConfig;
  getRoots(): WorkspaceRoot[];
  log(msg: string): void;
}

interface CacheEntry {
  versionKey: string;
  settingsKey: string;
  result: ReferenceResult;
}

/** ProbeFs over workspace.fs: async, never throws, never follows symlinks itself. */
function createProbeFs(): ProbeFs {
  const decoder = new TextDecoder('utf-8');
  return {
    async isFile(p: FileKey): Promise<boolean> {
      try {
        const stat = await vscode.workspace.fs.stat(uriFromKey(p));
        // bitwise test so symlinked files (File | SymbolicLink) count as files
        return (stat.type & vscode.FileType.File) !== 0;
      } catch {
        return false;
      }
    },
    async listDir(p: FileKey): Promise<string[]> {
      try {
        const entries = await vscode.workspace.fs.readDirectory(uriFromKey(p));
        return entries.map(([name]) => name);
      } catch {
        return [];
      }
    },
    async readText(p: FileKey, maxBytes: number): Promise<string | undefined> {
      try {
        const uri = uriFromKey(p);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxBytes * 4) return undefined;
        const data = await vscode.workspace.fs.readFile(uri);
        return decoder.decode(data.subarray(0, maxBytes));
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Debounced, single-flight reference analysis per edited file. Results are cached by document
 * identity + version (open documents) or mtime+size (disk), so unchanged files are never re-parsed.
 * Identity matters: a document closed unsaved and re-opened is a new object whose version restarts at 1.
 */
export class ReferenceService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<FileKey>();
  readonly onDidChange: vscode.Event<FileKey> = this.emitter.event;

  private readonly fs = createProbeFs();
  private readonly generations = new Map<FileKey, number>();
  private readonly timers = new Map<FileKey, { cancel(): void }>();
  private queue: FileKey[] = [];
  private running = false;
  private readonly cache = new Map<FileKey, CacheEntry>();
  private readonly docIds = new WeakMap<vscode.TextDocument, number>();
  private nextDocId = 1;
  private readonly projects = new Map<string, Promise<ProjectInfo>>();
  private idleWaiters: Array<() => void> = [];
  private matcher: { key: string; fn: (rel: string) => boolean } | undefined;
  private disposed = false;

  constructor(private readonly deps: ReferenceServiceDeps) {}

  /** Schedules (debounced) analysis of `key`; only the latest request per key runs. */
  request(key: FileKey): void {
    if (this.disposed) return;
    const gen = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, gen);
    this.timers.get(key)?.cancel();
    const handle = this.deps.scheduler.setTimeout(() => {
      this.timers.delete(key);
      if (this.disposed || this.generations.get(key) !== gen) {
        this.checkIdle();
        return;
      }
      this.queue = this.queue.filter((k) => k !== key);
      this.queue.push(key);
      void this.pump();
    }, K.REF_DEBOUNCE_MS);
    this.timers.set(key, handle);
  }

  get(key: FileKey): ReferenceResult | undefined {
    return this.cache.get(key)?.result;
  }

  results(): ReadonlyMap<FileKey, ReferenceResult> {
    const out = new Map<FileKey, ReferenceResult>();
    for (const [k, v] of this.cache) out.set(k, v.result);
    return out;
  }

  /**
   * Drops cached results for `prefix` and everything under it, and results that point at it.
   * Returns the sources whose result was dropped because it mentioned the path (callers re-request them).
   */
  invalidate(prefix: FileKey): FileKey[] {
    const dropped: FileKey[] = [];
    for (const [source, entry] of [...this.cache]) {
      const isSource = source === prefix || source.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
      const mentions = entry.result.targets.some(
        (t) => t.key === prefix || t.key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
      );
      if (isSource || mentions) {
        this.cache.delete(source);
        if (!isSource) dropped.push(source);
      }
    }
    // pending analyses of removed sources are discarded
    for (const key of [...this.timers.keys(), ...this.queue]) {
      if (key === prefix || key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) this.discard(key);
    }
    this.projects.clear();
    this.checkIdle();
    return dropped;
  }

  invalidateAll(): void {
    this.cache.clear();
    this.projects.clear();
    for (const key of [...this.timers.keys(), ...this.queue]) this.discard(key);
    this.checkIdle();
  }

  /** Forget cached tsconfig/go.mod/composer.json lookups (a watcher saw one change). */
  invalidateProjectInfo(): void {
    this.projects.clear();
  }

  /** Resolves when nothing is debouncing, queued or running. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
    this.queue = [];
    this.cache.clear();
    this.projects.clear();
    this.emitter.dispose();
    this.flushIdle();
  }

  // ----------------------------------------------------------------------------

  private discard(key: FileKey): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
    this.queue = this.queue.filter((k) => k !== key);
  }

  private isIdle(): boolean {
    return this.timers.size === 0 && this.queue.length === 0 && !this.running;
  }

  private flushIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private checkIdle(): void {
    if (this.isIdle()) this.flushIdle();
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (;;) {
        const key = this.queue.shift();
        if (key === undefined || this.disposed) break;
        const gen = this.generations.get(key) ?? 0;
        try {
          await this.analyze(key, gen);
        } catch (err) {
          this.deps.log(`analysis failed for ${key}: ${String(err)}`);
        }
      }
    } finally {
      this.running = false;
      this.checkIdle();
    }
  }

  private excludeFn(cfg: FileShakeConfig, roots: readonly WorkspaceRoot[]): (key: FileKey) => boolean {
    const id = JSON.stringify(cfg.excludeGlobs);
    if (this.matcher?.key !== id) {
      this.matcher = { key: id, fn: createExcludeMatcher(cfg.excludeGlobs, { nocase: process.platform === 'win32' }) };
    }
    const fn = this.matcher.fn;
    return (key) => fn(relativeForMatch(key, roots));
  }

  private projectInfo(from: FileKey, roots: readonly FileKey[]): Promise<ProjectInfo> {
    const cacheKey = `${dirname(from)}|${roots.join(',')}`;
    let p = this.projects.get(cacheKey);
    if (!p) {
      p = loadProjectInfo(this.fs, from, roots);
      this.projects.set(cacheKey, p);
    }
    return p;
  }

  private docId(doc: vscode.TextDocument): number {
    let id = this.docIds.get(doc);
    if (id === undefined) {
      id = this.nextDocId++;
      this.docIds.set(doc, id);
    }
    return id;
  }

  private async analyze(key: FileKey, gen: number): Promise<void> {
    const cfg = this.deps.getConfig();
    if (!cfg.enable) return;
    const roots = this.deps.getRoots();
    const maxBytes = cfg.maxFileSizeKb * 1024;
    const settingsKey = `${cfg.maxFileSizeKb}|${JSON.stringify(cfg.excludeGlobs)}`;

    let text: string;
    let languageId = '';
    let versionKey: string;

    const skip = (versionKey: string, skipped: NonNullable<ReferenceResult['skipped']>): void => {
      const result: ReferenceResult = {
        source: key,
        language: undefined,
        targets: [],
        truncated: false,
        unresolved: 0,
        skipped,
        parseMs: 0,
      };
      this.store(key, { versionKey, settingsKey, result }, gen);
    };

    const doc = vscode.workspace.textDocuments.find((d) => fileKeyFromUri(d.uri) === key);
    if (doc) {
      versionKey = `doc:${this.docId(doc)}:${doc.version}`;
      const cached = this.cache.get(key);
      if (cached && cached.versionKey === versionKey && cached.settingsKey === settingsKey) return;
      if (detectLanguage(doc.languageId, key) === undefined) return skip(versionKey, 'unsupported-language');
      text = doc.getText();
      languageId = doc.languageId;
    } else {
      const uri = uriFromKey(key);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        return; // deleted or unreadable: nothing to show
      }
      versionKey = `disk:${stat.mtime}:${stat.size}`;
      const cached = this.cache.get(key);
      if (cached && cached.versionKey === versionKey && cached.settingsKey === settingsKey) return;
      if (detectLanguage('', key) === undefined) return skip(versionKey, 'unsupported-language');
      // never read a huge file; report it as skipped
      if (stat.size > maxBytes) return skip(versionKey, 'too-large');
      try {
        text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return;
      }
      if (this.generations.get(key) !== gen) return;
    }

    // a file outside every workspace folder is analysed relative to its own directory
    const rootKeys = roots.map((r) => r.key).filter((r) => isUnder(r, key));
    const project = await this.projectInfo(key, rootKeys.length > 0 ? roots.map((r) => r.key) : [dirname(key)]);
    if (this.disposed || this.generations.get(key) !== gen) return;
    const result = await analyzeReferences({
      path: key,
      languageId,
      text,
      fs: this.fs,
      project,
      isExcluded: this.excludeFn(cfg, roots),
      maxFileSizeKb: cfg.maxFileSizeKb,
    });
    this.store(key, { versionKey, settingsKey, result }, gen);
  }

  private store(key: FileKey, entry: CacheEntry, gen: number): void {
    if (this.disposed || this.generations.get(key) !== gen) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.emitter.fire(key);
  }
}
