import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock, ManualScheduler, systemClock, systemScheduler } from '../../src/core/clock';
import { EventLog } from '../../src/core/eventLog';
import { K } from '../../src/core/constants';
import type { LogEntry } from '../support/types';

describe('ManualClock', () => {
  it('starts at the given time (default 0) and only moves when told to', () => {
    assert.equal(new ManualClock().now(), 0);
    const c = new ManualClock(1234);
    assert.equal(c.now(), 1234);
    assert.equal(c.now(), 1234);
  });

  it('advance adds, set replaces (and may move backwards)', () => {
    const c = new ManualClock(100);
    c.advance(50);
    assert.equal(c.now(), 150);
    c.set(10);
    assert.equal(c.now(), 10);
    c.advance(0);
    assert.equal(c.now(), 10);
  });
});

describe('ManualScheduler', () => {
  it('runs nothing until advance reaches the due time', () => {
    const clock = new ManualClock(1000);
    const s = new ManualScheduler(clock);
    const fired: number[] = [];
    s.setTimeout(() => fired.push(clock.now()), 200);
    assert.equal(s.pending, 1);
    s.advance(199);
    assert.deepEqual(fired, []);
    assert.equal(s.pending, 1);
    s.advance(1);
    assert.equal(fired.length, 1);
    assert.equal(s.pending, 0);
    assert.equal(clock.now(), 1200);
  });

  it('advance moves the shared clock by exactly the requested amount', () => {
    const clock = new ManualClock(0);
    const s = new ManualScheduler(clock);
    s.advance(750);
    assert.equal(clock.now(), 750);
    s.setTimeout(() => undefined, 100);
    s.advance(1000);
    assert.equal(clock.now(), 1750);
  });

  it('runs due callbacks in time order, then insertion order for ties', () => {
    const clock = new ManualClock(0);
    const s = new ManualScheduler(clock);
    const order: string[] = [];
    s.setTimeout(() => order.push('c@300'), 300);
    s.setTimeout(() => order.push('a@100'), 100);
    s.setTimeout(() => order.push('b1@200'), 200);
    s.setTimeout(() => order.push('b2@200'), 200);
    s.advance(1000);
    assert.deepEqual(order, ['a@100', 'b1@200', 'b2@200', 'c@300']);
  });

  it('runs callbacks scheduled by callbacks if they fall inside the same advance', () => {
    const clock = new ManualClock(0);
    const s = new ManualScheduler(clock);
    const fired: number[] = [];
    const chain = (): void => {
      fired.push(clock.now());
      if (fired.length < 10) s.setTimeout(chain, 100);
    };
    s.setTimeout(chain, 100);
    s.advance(450);
    assert.deepEqual(fired, [100, 200, 300, 400]);
    assert.equal(s.pending, 1, 'the 5th link is scheduled but not yet due');
    s.advance(50);
    assert.equal(fired.length, 5);
  });

  it('a callback observes the clock at its due time, not at the end of the advance', () => {
    const clock = new ManualClock(0);
    const s = new ManualScheduler(clock);
    let seen = -1;
    s.setTimeout(() => {
      seen = clock.now();
    }, 250);
    s.advance(1000);
    assert.equal(seen, 250);
    assert.equal(clock.now(), 1000);
  });

  it('cancel prevents the callback and is idempotent; cancel after fire is harmless', () => {
    const clock = new ManualClock(0);
    const s = new ManualScheduler(clock);
    let a = 0;
    let b = 0;
    const ha = s.setTimeout(() => a++, 100);
    const hb = s.setTimeout(() => b++, 100);
    ha.cancel();
    ha.cancel();
    assert.equal(s.pending, 1);
    s.advance(100);
    assert.equal(a, 0);
    assert.equal(b, 1);
    hb.cancel();
    assert.equal(s.pending, 0);
  });

  it('a zero-delay timeout fires on the next advance (even advance(0))', () => {
    const clock = new ManualClock(5);
    const s = new ManualScheduler(clock);
    let n = 0;
    s.setTimeout(() => n++, 0);
    s.advance(0);
    assert.equal(n, 1);
  });

  it('pending counts only live timers', () => {
    const s = new ManualScheduler(new ManualClock());
    assert.equal(s.pending, 0);
    const h1 = s.setTimeout(() => undefined, 10);
    s.setTimeout(() => undefined, 20);
    assert.equal(s.pending, 2);
    h1.cancel();
    assert.equal(s.pending, 1);
    s.advance(100);
    assert.equal(s.pending, 0);
  });
});

describe('systemClock / systemScheduler', () => {
  it('systemClock.now tracks Date.now', () => {
    const before = Date.now();
    const t = systemClock.now();
    const after = Date.now();
    assert.ok(t >= before && t <= after);
  });

  it('systemScheduler fires and cancel really cancels (ordering-based, no sleeps)', async () => {
    let fired = false;
    const h = systemScheduler.setTimeout(() => {
      fired = true;
    }, 1);
    h.cancel();
    await new Promise<void>((resolve) => {
      systemScheduler.setTimeout(resolve, 25);
    });
    assert.equal(fired, false, 'cancelled timer must not fire before a later one');
    let ran = false;
    await new Promise<void>((resolve) => {
      systemScheduler.setTimeout(() => {
        ran = true;
        resolve();
      }, 1);
    });
    assert.equal(ran, true);
  });
});

describe('EventLog', () => {
  const entry = (n: number): LogEntry => ({
    at: n,
    key: `/f${n}.ts`,
    origin: 'doc',
    decision: 'you',
    reason: 'active-focused-edit',
    weight: 1,
  });

  it('keeps entries oldest-first', () => {
    const log = new EventLog(5);
    log.add(entry(1));
    log.add(entry(2));
    log.add(entry(3));
    assert.deepEqual(
      log.entries().map((e) => e.at),
      [1, 2, 3],
    );
  });

  it('is a ring buffer: only the newest `size` entries survive, still oldest first', () => {
    const log = new EventLog(3);
    for (let i = 1; i <= 10; i++) log.add(entry(i));
    assert.deepEqual(
      log.entries().map((e) => e.at),
      [8, 9, 10],
    );
  });

  it('defaults to EVENT_LOG_SIZE (50)', () => {
    assert.equal(K.EVENT_LOG_SIZE, 50);
    const log = new EventLog();
    for (let i = 1; i <= 120; i++) log.add(entry(i));
    const es = log.entries();
    assert.equal(es.length, 50);
    assert.equal(es[0]?.at, 71);
    assert.equal(es[49]?.at, 120);
  });

  it('clear empties it and it stays usable', () => {
    const log = new EventLog(3);
    log.add(entry(1));
    log.clear();
    assert.equal(log.entries().length, 0);
    log.add(entry(2));
    assert.deepEqual(
      log.entries().map((e) => e.at),
      [2],
    );
  });

  it('entries() returns a stable copy: later adds do not mutate an earlier result', () => {
    const log = new EventLog(10);
    log.add(entry(1));
    const before = log.entries();
    const lenBefore = before.length;
    log.add(entry(2));
    assert.equal(before.length, lenBefore);
  });
});
