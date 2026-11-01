import { K } from './constants';
import type { LogEntry } from './types';

/** Bounded ring buffer of classification decisions, for the debug command. */
export class EventLog {
  private buf: LogEntry[] = [];

  constructor(private readonly size: number = K.EVENT_LOG_SIZE) {}

  add(e: LogEntry): void {
    this.buf.push(e);
    const excess = this.buf.length - Math.max(1, this.size);
    if (excess > 0) this.buf.splice(0, excess);
  }

  /** Oldest first, at most `size` entries. */
  entries(): readonly LogEntry[] {
    return this.buf.slice();
  }

  clear(): void {
    this.buf = [];
  }
}
