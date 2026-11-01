import { K } from './constants';
import type { Clock, FileKey } from './types';

/**
 * Suppresses floods (git checkout, codegen): more than `limit` distinct files inside `windowMs`
 * starts a cooldown during which every call is rejected.
 */
export class BurstGuard {
  private readonly seen = new Map<FileKey, number>();
  private cooldownUntil = -Infinity;

  constructor(
    private readonly clock: Clock,
    private readonly limit: number = K.BURST_LIMIT,
    private readonly windowMs: number = K.BURST_WINDOW_MS,
    private readonly cooldownMs: number = K.BURST_COOLDOWN_MS,
  ) {}

  accept(key: FileKey): boolean {
    const now = this.clock.now();
    if (now < this.cooldownUntil) return false;

    for (const [k, at] of this.seen) {
      if (now - at >= this.windowMs) this.seen.delete(k);
    }
    if (this.seen.has(key)) {
      this.seen.set(key, now);
      return true;
    }
    if (this.seen.size + 1 > this.limit) {
      this.cooldownUntil = now + this.cooldownMs;
      this.seen.clear();
      return false;
    }
    this.seen.set(key, now);
    return true;
  }
}
