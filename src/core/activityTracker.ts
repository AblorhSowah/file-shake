import { K } from './constants';
import { editIntensity, windowRate } from './intensity';
import type { WeightedEvent } from './intensity';
import { isUnder } from './pathUtils';
import type { Clock, EditSource, FileKey, TrackedFile } from './types';

export interface TrackerOptions {
  windowMs: number;
  idleTimeoutMs: number;
  retainAfterIdleMs: number;
  maxFiles: number;
  sensitivity: number;
  showWhenIdle: boolean;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  windowMs: 3000,
  idleTimeoutMs: 2500,
  retainAfterIdleMs: 4000,
  maxFiles: 40,
  sensitivity: 1,
  showWhenIdle: false,
};

export interface EditInput {
  key: FileKey;
  source: EditSource;
  weight: number;
  /** defaults to clock.now() */
  at?: number;
}

interface Entry {
  key: FileKey;
  source: EditSource;
  events: WeightedEvent[];
  firstEditAt: number;
  lastEditAt: number;
  lastExternalAt: number | undefined;
  editCount: number;
}

/** Sliding-window edit tracker. Pure: time comes from the injected clock. */
export class ActivityTracker {
  private opts: TrackerOptions;
  private readonly entries = new Map<FileKey, Entry>();

  constructor(
    private readonly clock: Clock,
    options: Partial<TrackerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  setOptions(patch: Partial<TrackerOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.evictOverflow();
  }

  /** false = ignored (bad weight, or an external duplicate within EXTERNAL_DEDUPE_MS). */
  record(input: EditInput): boolean {
    if (!Number.isFinite(input.weight) || input.weight <= 0) return false;
    const now = this.clock.now();
    const at = input.at ?? now;
    let entry = this.entries.get(input.key);

    if (
      input.source === 'external' &&
      entry?.lastExternalAt !== undefined &&
      at - entry.lastExternalAt < K.EXTERNAL_DEDUPE_MS
    ) {
      return false;
    }

    if (!entry) {
      entry = {
        key: input.key,
        source: input.source,
        events: [],
        firstEditAt: at,
        lastEditAt: at,
        lastExternalAt: undefined,
        editCount: 0,
      };
      this.entries.set(input.key, entry);
    }

    entry.events.push({ at, weight: input.weight });
    entry.source = input.source;
    entry.lastEditAt = Math.max(entry.lastEditAt, at);
    if (input.source === 'external') entry.lastExternalAt = at;
    entry.editCount += 1;
    this.prune(entry, now);
    this.evictOverflow();
    return true;
  }

  /** Prunes and removes expired entries at clock.now(); sorted lastEditAt desc, then key asc. */
  snapshot(): TrackedFile[] {
    const now = this.clock.now();
    const out: TrackedFile[] = [];
    for (const entry of [...this.entries.values()]) {
      const file = this.compute(entry, now);
      if (file) out.push(file);
    }
    out.sort((a, b) => b.lastEditAt - a.lastEditAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  get(key: FileKey): TrackedFile | undefined {
    const entry = this.entries.get(key);
    return entry ? this.compute(entry, this.clock.now()) : undefined;
  }

  primary(): TrackedFile | undefined {
    return this.snapshot().find((f) => f.phase === 'active');
  }

  forget(key: FileKey): boolean {
    return this.entries.delete(key);
  }

  /** Removes `prefix` itself and everything under it. */
  forgetUnder(prefix: FileKey): number {
    let n = 0;
    for (const key of [...this.entries.keys()]) {
      if (isUnder(prefix, key) && this.entries.delete(key)) n += 1;
    }
    return n;
  }

  /** Re-keys state (also folder renames); overwrites existing target state. Returns how many entries moved. */
  renameUnder(oldPrefix: FileKey, newPrefix: FileKey): number {
    const moved: Entry[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (isUnder(oldPrefix, key)) {
        this.entries.delete(key);
        moved.push(entry);
      }
    }
    for (const entry of moved) {
      const rest = entry.key.slice(oldPrefix.length);
      const joined =
        rest === '' ? newPrefix : newPrefix.endsWith('/') || rest.startsWith('/') ? newPrefix + rest : `${newPrefix}/${rest}`;
      entry.key = joined;
      this.entries.set(joined, entry);
    }
    return moved.length;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private compute(entry: Entry, now: number): TrackedFile | undefined {
    const o = this.opts;
    const since = Math.max(0, now - entry.lastEditAt);
    if (!o.showWhenIdle && since >= o.idleTimeoutMs + o.retainAfterIdleMs) {
      this.entries.delete(entry.key);
      return undefined;
    }
    this.prune(entry, now);
    const active = since < o.idleTimeoutMs;
    const w = Math.max(o.windowMs, o.idleTimeoutMs);
    return {
      key: entry.key,
      source: entry.source,
      phase: active ? 'active' : 'idle',
      intensity: active
        ? editIntensity(entry.events, now, {
            windowMs: o.windowMs,
            idleTimeoutMs: o.idleTimeoutMs,
            sensitivity: o.sensitivity,
          })
        : 0,
      rate: windowRate(entry.events, now, w),
      firstEditAt: entry.firstEditAt,
      lastEditAt: entry.lastEditAt,
      editCount: entry.editCount,
    };
  }

  /** Drops events older than max(windowMs, idleTimeoutMs) and enforces MAX_EVENTS_PER_FILE. */
  private prune(entry: Entry, now: number): void {
    const horizon = Math.max(this.opts.windowMs, this.opts.idleTimeoutMs);
    const kept = entry.events.filter((e) => now - e.at < horizon);
    if (kept.length > K.MAX_EVENTS_PER_FILE) kept.splice(0, kept.length - K.MAX_EVENTS_PER_FILE);
    entry.events = kept;
  }

  private evictOverflow(): void {
    while (this.entries.size > Math.max(1, this.opts.maxFiles)) {
      let victim: Entry | undefined;
      for (const e of this.entries.values()) {
        if (!victim || e.lastEditAt < victim.lastEditAt || (e.lastEditAt === victim.lastEditAt && e.key < victim.key)) {
          victim = e;
        }
      }
      if (!victim) return;
      this.entries.delete(victim.key);
    }
  }
}
