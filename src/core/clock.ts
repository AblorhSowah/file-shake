import type { Clock, Scheduler } from './types';

/** Deterministic clock for tests and the integration seam. */
export class ManualClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(t: number): void {
    this.t = t;
  }
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/** Scheduler driven by a ManualClock: callbacks only run inside `advance`. */
export class ManualScheduler implements Scheduler {
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(private readonly clock: ManualClock) {}

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer: Timer = {
      id: this.nextId++,
      at: this.clock.now() + Math.max(0, ms),
      fn,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
        this.timers = this.timers.filter((t) => t !== timer);
      },
    };
  }

  /** Advances the clock by `ms`, running due callbacks in time order (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.clock.now() + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.cancelled || t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
      }
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      if (next.at > this.clock.now()) this.clock.set(next.at);
      next.fn();
    }
    if (this.clock.now() < target) this.clock.set(target);
  }

  get pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const handle: ReturnType<typeof setTimeout> = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};
