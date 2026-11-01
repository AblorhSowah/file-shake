import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, DEFAULT_TRACKER_OPTIONS } from '../../src/core/activityTracker';
import { ManualClock } from '../../src/core/clock';
import { changeWeight } from '../../src/core/intensity';
import { K } from '../../src/core/constants';
import { must } from '../support/fixtures';

const T0 = 1_000_000;
const A = '/ws/a.ts';
const B = '/ws/b.ts';
const C = '/ws/c.ts';

function setup(opts: Partial<ConstructorParameters<typeof ActivityTracker>[1] & object> = {}): {
  clock: ManualClock;
  tracker: ActivityTracker;
} {
  const clock = new ManualClock(T0);
  return { clock, tracker: new ActivityTracker(clock, opts) };
}

function near(actual: number, expected: number, tol = 1e-3): void {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} +/- ${tol}, got ${actual}`);
}

describe('ActivityTracker: options and record validation', () => {
  it('defaults are 3000 / 2500 / 4000 / 40 / 1 / false', () => {
    assert.deepEqual(DEFAULT_TRACKER_OPTIONS, {
      windowMs: 3000,
      idleTimeoutMs: 2500,
      retainAfterIdleMs: 4000,
      maxFiles: 40,
      sensitivity: 1,
      showWhenIdle: false,
    });
  });

  it('starts empty', () => {
    const { tracker } = setup();
    assert.equal(tracker.size, 0);
    assert.deepEqual(tracker.snapshot(), []);
    assert.equal(tracker.primary(), undefined);
    assert.equal(tracker.get(A), undefined);
  });

  it('record returns true for accepted events', () => {
    const { tracker } = setup();
    assert.equal(tracker.record({ key: A, source: 'you', weight: 1 }), true);
    assert.equal(tracker.size, 1);
  });

  for (const w of [0, -1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects weight ${w} (returns false, records nothing)`, () => {
      const { tracker } = setup();
      assert.equal(tracker.record({ key: A, source: 'you', weight: w }), false);
      assert.equal(tracker.size, 0);
      assert.deepEqual(tracker.snapshot(), []);
    });
  }

  it('a rejected event does not touch an existing entry', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(100);
    tracker.record({ key: A, source: 'external', weight: 0 });
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 1);
    assert.equal(f.lastEditAt, T0);
    assert.equal(f.source, 'you');
  });

  it('an explicit `at` overrides the clock', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1, at: T0 - 700 });
    const f = must(tracker.get(A));
    assert.equal(f.lastEditAt, T0 - 700);
    assert.equal(f.firstEditAt, T0 - 700);
  });
});

describe('ActivityTracker: worked examples through the tracker (DESIGN 6)', () => {
  it('1 keystroke: fields at T0', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    const f = must(tracker.get(A));
    assert.equal(f.key, A);
    assert.equal(f.source, 'you');
    assert.equal(f.phase, 'active');
    near(f.intensity, 0.2835);
    near(f.rate, 2);
    assert.equal(f.firstEditAt, T0);
    assert.equal(f.lastEditAt, T0);
    assert.equal(f.editCount, 1);
  });

  it('1 keystroke: intensity and rate follow the table over time, with the idle boundary at exactly idleTimeoutMs', () => {
    const rows: Array<[number, number, number]> = [
      [0, 0.2835, 2],
      [250, 0.2551, 2],
      [500, 0.2268, 2],
      [1000, 0.0921, 1],
      [1500, 0.048, 0.667],
      [2000, 0.024, 0.5],
    ];
    for (const [dt, intensity, rate] of rows) {
      const { clock, tracker } = setup();
      tracker.record({ key: A, source: 'you', weight: 1 });
      clock.advance(dt);
      const f = must(tracker.get(A));
      assert.equal(f.phase, 'active', `dt=${dt}`);
      near(f.intensity, intensity);
      near(f.rate, rate);
    }
    // 2499: still active, tiny intensity
    {
      const { clock, tracker } = setup();
      tracker.record({ key: A, source: 'you', weight: 1 });
      clock.advance(2499);
      const f = must(tracker.get(A));
      assert.equal(f.phase, 'active');
      assert.ok(f.intensity > 0 && f.intensity < 0.001);
      near(f.rate, 0.4);
    }
    // 2500: idle, intensity 0, rate still reported
    {
      const { clock, tracker } = setup();
      tracker.record({ key: A, source: 'you', weight: 1 });
      clock.advance(2500);
      const f = must(tracker.get(A));
      assert.equal(f.phase, 'idle');
      assert.equal(f.intensity, 0);
      near(f.rate, 0.4);
    }
  });

  it('15 keystrokes 200ms apart (fake clock stepping) -> rate 5.357, intensity 0.5905', () => {
    const { clock, tracker } = setup();
    for (let k = 1; k <= 15; k++) {
      clock.advance(200);
      assert.equal(tracker.record({ key: A, source: 'you', weight: 1 }), true);
    }
    assert.equal(clock.now(), T0 + 3000);
    const f = must(tracker.get(A));
    near(f.rate, 5.357);
    near(f.intensity, 0.5905);
    assert.equal(f.editCount, 15);
    assert.equal(f.firstEditAt, T0 + 200);
    assert.equal(f.lastEditAt, T0 + 3000);
  });

  it('the same 15 keystrokes recorded with explicit `at` give the same numbers', () => {
    const { clock, tracker } = setup();
    for (let k = 1; k <= 15; k++) tracker.record({ key: A, source: 'you', weight: 1, at: T0 + 200 * k });
    clock.set(T0 + 3000);
    const f = must(tracker.get(A));
    near(f.rate, 5.357);
    near(f.intensity, 0.5905);
  });

  it('paste of 500 chars (weight 9.966): intensity over time', () => {
    const rows: Array<[number, number]> = [
      [0, 0.9639],
      [500, 0.7711],
      [1000, 0.486],
      [2000, 0.1128],
    ];
    for (const [dt, expected] of rows) {
      const { clock, tracker } = setup();
      tracker.record({ key: A, source: 'you', weight: changeWeight(500) });
      clock.advance(dt);
      near(must(tracker.get(A)).intensity, expected);
    }
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: changeWeight(500) });
    clock.advance(2500);
    assert.equal(must(tracker.get(A)).intensity, 0);
    assert.equal(must(tracker.get(A)).phase, 'idle');
  });

  it('external write (weight 6): intensity over time and source label', () => {
    const rows: Array<[number, number]> = [
      [0, 0.8647],
      [500, 0.6917],
      [1000, 0.3793],
      [1250, 0.2753],
      [2000, 0.0787],
    ];
    for (const [dt, expected] of rows) {
      const { clock, tracker } = setup();
      tracker.record({ key: A, source: 'external', weight: K.EXTERNAL_EVENT_WEIGHT });
      clock.advance(dt);
      const f = must(tracker.get(A));
      near(f.intensity, expected);
      assert.equal(f.source, 'external');
    }
  });
});

describe('ActivityTracker: expiry and retention', () => {
  it('idle files are retained for retainAfterIdleMs and then removed (showWhenIdle=false)', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(2500 + 4000 - 1);
    const f = must(tracker.get(A));
    assert.equal(f.phase, 'idle');
    assert.equal(tracker.snapshot().length, 1);
    clock.advance(1);
    assert.deepEqual(tracker.snapshot(), []);
    assert.equal(tracker.get(A), undefined);
    assert.equal(tracker.size, 0, 'snapshot() prunes expired entries');
  });

  it('showWhenIdle keeps idle files indefinitely, at intensity 0', () => {
    const { clock, tracker } = setup({ showWhenIdle: true });
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(3_600_000);
    const [f] = tracker.snapshot();
    assert.ok(f);
    assert.equal(f.phase, 'idle');
    assert.equal(f.intensity, 0);
    assert.equal(f.rate, 0, 'the event aged out of the window, so rate is 0');
    assert.equal(f.editCount, 1);
  });

  it('setOptions({showWhenIdle}) is evaluated at prune time, in both directions', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(20_000);
    tracker.setOptions({ showWhenIdle: true });
    assert.equal(tracker.snapshot().length, 1, 'kept: showWhenIdle was switched on before the first prune');
    tracker.setOptions({ showWhenIdle: false });
    assert.equal(tracker.snapshot().length, 0, 'removed: expiry applies again once showWhenIdle is off');
  });

  it('re-editing after removal starts a fresh entry (editCount 1)', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(7000);
    assert.equal(tracker.snapshot().length, 0);
    tracker.record({ key: A, source: 'you', weight: 1 });
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 1);
    assert.equal(f.firstEditAt, T0 + 7000);
  });

  it('an entry that survives (showWhenIdle) keeps its lifetime editCount and firstEditAt', () => {
    const { clock, tracker } = setup({ showWhenIdle: true });
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(10_000);
    tracker.record({ key: A, source: 'you', weight: 1 });
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 2);
    assert.equal(f.firstEditAt, T0);
    assert.equal(f.lastEditAt, T0 + 10_000);
    assert.equal(f.phase, 'active');
  });

  it('events older than max(windowMs, idleTimeoutMs) do not contribute to the rate', () => {
    const { clock, tracker } = setup({ showWhenIdle: true });
    tracker.record({ key: A, source: 'you', weight: 50 });
    clock.advance(10_000);
    tracker.record({ key: A, source: 'you', weight: 1 });
    near(must(tracker.get(A)).rate, 2);
  });
});

describe('ActivityTracker: source and dedupe', () => {
  it('source follows the most recent accepted event', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.equal(must(tracker.get(A)).source, 'you');
    clock.advance(100);
    tracker.record({ key: A, source: 'external', weight: 6 });
    assert.equal(must(tracker.get(A)).source, 'external');
    clock.advance(100);
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.equal(must(tracker.get(A)).source, 'you');
  });

  it('a second external event within EXTERNAL_DEDUPE_MS is rejected and changes nothing', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.record({ key: A, source: 'external', weight: 6 }), true);
    clock.advance(K.EXTERNAL_DEDUPE_MS - 1);
    assert.equal(tracker.record({ key: A, source: 'external', weight: 6 }), false);
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 1);
    assert.equal(f.lastEditAt, T0);
  });

  it('an external event after the dedupe window is accepted', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'external', weight: 6 });
    clock.advance(K.EXTERNAL_DEDUPE_MS + 1);
    assert.equal(tracker.record({ key: A, source: 'external', weight: 6 }), true);
    assert.equal(must(tracker.get(A)).editCount, 2);
  });

  it('dedupe is per file', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.record({ key: A, source: 'external', weight: 6 }), true);
    clock.advance(10);
    assert.equal(tracker.record({ key: B, source: 'external', weight: 6 }), true);
    assert.equal(tracker.size, 2);
  });

  it('dedupe only applies to external events: typing right after an external write is accepted', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'external', weight: 6 });
    clock.advance(10);
    assert.equal(tracker.record({ key: A, source: 'you', weight: 1 }), true);
    assert.equal(must(tracker.get(A)).source, 'you');
    clock.advance(10);
    assert.equal(tracker.record({ key: A, source: 'you', weight: 1 }), true, 'rapid typing is never deduped');
  });

  it('an external event following typing is not deduped by the typing event', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(10);
    assert.equal(tracker.record({ key: A, source: 'external', weight: 6 }), true);
  });
});

describe('ActivityTracker: ordering, primary, get', () => {
  it('snapshot is sorted by lastEditAt desc, then key asc', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: B, source: 'you', weight: 1 });
    clock.advance(10);
    tracker.record({ key: C, source: 'you', weight: 1 });
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.deepEqual(
      tracker.snapshot().map((f) => f.key),
      [A, C, B],
    );
  });

  it('primary is the first active entry; undefined when everything is idle', () => {
    const { clock, tracker } = setup({ showWhenIdle: true });
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(1000);
    tracker.record({ key: B, source: 'you', weight: 1 });
    assert.equal(must(tracker.primary()).key, B);
    clock.advance(2500);
    assert.equal(tracker.primary(), undefined, 'all idle');
    assert.equal(tracker.snapshot().length, 2);
  });

  it('get agrees with snapshot for the same file', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 2 });
    clock.advance(777);
    assert.deepEqual(tracker.get(A), tracker.snapshot()[0]);
  });

  it('get for an unknown or expired file is undefined', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.get('/nope'), undefined);
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(10_000);
    assert.equal(tracker.get(A), undefined);
  });

  it('files in two roots with the same basename are distinct entries', () => {
    const { tracker } = setup();
    tracker.record({ key: '/w1/x.ts', source: 'you', weight: 1 });
    tracker.record({ key: '/w2/x.ts', source: 'you', weight: 1 });
    assert.equal(tracker.size, 2);
  });

  it('keys are compared exactly (case-sensitive; only the drive letter is normalised upstream)', () => {
    const { tracker } = setup();
    tracker.record({ key: '/ws/File.ts', source: 'you', weight: 1 });
    tracker.record({ key: '/ws/file.ts', source: 'you', weight: 1 });
    assert.equal(tracker.size, 2);
  });
});

describe('ActivityTracker: forget / forgetUnder / renameUnder / clear', () => {
  it('forget removes one file and reports whether it existed', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.equal(tracker.forget(A), true);
    assert.equal(tracker.forget(A), false);
    assert.equal(tracker.size, 0);
  });

  it('forgetUnder removes the prefix itself and everything below it, but not siblings sharing a name prefix', () => {
    const { tracker } = setup();
    for (const k of ['/p/dir', '/p/dir/x.ts', '/p/dir/sub/y.ts', '/p/dirx/z.ts', '/p/other.ts']) {
      tracker.record({ key: k, source: 'you', weight: 1 });
    }
    assert.equal(tracker.forgetUnder('/p/dir'), 3);
    assert.deepEqual(
      tracker
        .snapshot()
        .map((f) => f.key)
        .sort(),
      ['/p/dirx/z.ts', '/p/other.ts'],
    );
    assert.equal(tracker.forgetUnder('/p/none'), 0);
  });

  it('forgetUnder on the root removes everything', () => {
    const { tracker } = setup();
    tracker.record({ key: '/a.ts', source: 'you', weight: 1 });
    tracker.record({ key: '/b/c.ts', source: 'you', weight: 1 });
    assert.equal(tracker.forgetUnder('/'), 2);
  });

  it('renameUnder re-keys a file and keeps its state', () => {
    const { clock, tracker } = setup();
    for (let i = 0; i < 4; i++) {
      tracker.record({ key: '/p/old.ts', source: 'you', weight: 1 });
      clock.advance(50);
    }
    const before = must(tracker.get('/p/old.ts'));
    tracker.renameUnder('/p/old.ts', '/p/new.ts');
    assert.equal(tracker.get('/p/old.ts'), undefined);
    const after = must(tracker.get('/p/new.ts'));
    assert.equal(after.editCount, 4);
    assert.equal(after.firstEditAt, before.firstEditAt);
    assert.equal(after.lastEditAt, before.lastEditAt);
    near(after.intensity, before.intensity, 1e-9);
    assert.equal(after.key, '/p/new.ts');
  });

  it('renameUnder re-keys a whole folder but not look-alike siblings', () => {
    const { tracker } = setup();
    for (const k of ['/p/dir/x.ts', '/p/dir/sub/y.ts', '/p/dirx/z.ts']) {
      tracker.record({ key: k, source: 'you', weight: 1 });
    }
    assert.equal(tracker.renameUnder('/p/dir', '/p/dir2'), 2, 'reports how many entries were re-keyed');
    assert.deepEqual(
      tracker
        .snapshot()
        .map((f) => f.key)
        .sort(),
      ['/p/dir2/sub/y.ts', '/p/dir2/x.ts', '/p/dirx/z.ts'],
    );
  });

  it('renameUnder overwrites existing state at the target', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: '/p/new.ts', source: 'external', weight: 6 });
    clock.advance(500);
    tracker.record({ key: '/p/old.ts', source: 'you', weight: 1 });
    tracker.record({ key: '/p/old.ts', source: 'you', weight: 1 });
    tracker.renameUnder('/p/old.ts', '/p/new.ts');
    assert.equal(tracker.size, 1);
    const f = must(tracker.get('/p/new.ts'));
    assert.equal(f.editCount, 2);
    assert.equal(f.source, 'you');
  });

  it('renameUnder of an unknown prefix is a no-op', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.equal(tracker.renameUnder('/nope', '/other'), 0, 'nothing moved');
    assert.equal(tracker.size, 1);
    assert.ok(tracker.get(A));
  });

  it('clear empties everything', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    tracker.record({ key: B, source: 'you', weight: 1 });
    tracker.clear();
    assert.equal(tracker.size, 0);
    assert.deepEqual(tracker.snapshot(), []);
    assert.equal(tracker.primary(), undefined);
  });

  it('after forget, a new edit starts from editCount 1', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    tracker.record({ key: A, source: 'you', weight: 1 });
    tracker.forget(A);
    tracker.record({ key: A, source: 'you', weight: 1 });
    assert.equal(must(tracker.get(A)).editCount, 1);
  });
});

describe('ActivityTracker: maxFiles eviction', () => {
  it('evicts the file with the smallest lastEditAt when over the cap', () => {
    const { clock, tracker } = setup({ maxFiles: 5 });
    for (let i = 0; i < 6; i++) {
      tracker.record({ key: `/ws/f${i}.ts`, source: 'you', weight: 1 });
      clock.advance(10);
    }
    assert.equal(tracker.size, 5);
    assert.equal(tracker.get('/ws/f0.ts'), undefined, 'oldest evicted');
    assert.ok(tracker.get('/ws/f5.ts'));
  });

  it('ties on lastEditAt evict the smallest key', () => {
    const { tracker } = setup({ maxFiles: 5 });
    for (const k of ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts', '/ws/d.ts', '/ws/e.ts', '/ws/z.ts']) {
      tracker.record({ key: k, source: 'you', weight: 1 });
    }
    assert.equal(tracker.size, 5);
    assert.equal(tracker.get('/ws/a.ts'), undefined);
    assert.ok(tracker.get('/ws/z.ts'));
  });

  it('re-editing an old file refreshes it so it is not the eviction victim', () => {
    const { clock, tracker } = setup({ maxFiles: 5 });
    for (let i = 0; i < 5; i++) {
      tracker.record({ key: `/ws/f${i}.ts`, source: 'you', weight: 1 });
      clock.advance(10);
    }
    tracker.record({ key: '/ws/f0.ts', source: 'you', weight: 1 });
    clock.advance(10);
    tracker.record({ key: '/ws/f9.ts', source: 'you', weight: 1 });
    assert.ok(tracker.get('/ws/f0.ts'));
    assert.equal(tracker.get('/ws/f1.ts'), undefined);
    assert.equal(tracker.size, 5);
  });

  it('shrinking maxFiles via setOptions is honoured by the next record (size never stays above the cap)', () => {
    const { clock, tracker } = setup({ maxFiles: 40 });
    for (let i = 0; i < 12; i++) {
      tracker.record({ key: `/ws/f${i}.ts`, source: 'you', weight: 1 });
      clock.advance(1);
    }
    tracker.setOptions({ maxFiles: 5 });
    tracker.record({ key: '/ws/new.ts', source: 'you', weight: 1 });
    assert.ok(tracker.size <= 5, `size is ${tracker.size}`);
    assert.ok(tracker.get('/ws/new.ts'), 'the newest file survives');
  });
});

describe('ActivityTracker: setOptions applies live', () => {
  it('sensitivity', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    const mid = must(tracker.get(A)).intensity;
    tracker.setOptions({ sensitivity: 4 });
    const hi = must(tracker.get(A)).intensity;
    tracker.setOptions({ sensitivity: 0.25 });
    const lo = must(tracker.get(A)).intensity;
    assert.ok(lo < mid && mid < hi, `${lo} < ${mid} < ${hi}`);
  });

  it('idleTimeoutMs moves the idle boundary', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(1000);
    assert.equal(must(tracker.get(A)).phase, 'active');
    tracker.setOptions({ idleTimeoutMs: 800 });
    assert.equal(must(tracker.get(A)).phase, 'idle');
    tracker.setOptions({ idleTimeoutMs: 5000 });
    assert.equal(must(tracker.get(A)).phase, 'active');
  });

  it('a partial patch leaves the other options alone', () => {
    const { clock, tracker } = setup();
    tracker.setOptions({ sensitivity: 2 });
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(2499);
    assert.equal(must(tracker.get(A)).phase, 'active', 'idleTimeoutMs still 2500');
    clock.advance(1);
    assert.equal(must(tracker.get(A)).phase, 'idle');
  });

  it('retainAfterIdleMs is configurable', () => {
    const { clock, tracker } = setup({ retainAfterIdleMs: 100 });
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.advance(2500 + 99);
    assert.equal(tracker.snapshot().length, 1);
    clock.advance(1);
    assert.equal(tracker.snapshot().length, 0);
  });
});

describe('ActivityTracker: clock regression and memory bounds', () => {
  it('a clock that moves backwards clamps "since" to 0 (still active, finite values)', () => {
    const { clock, tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1 });
    clock.set(T0 - 5000);
    const f = must(tracker.get(A));
    assert.equal(f.phase, 'active');
    assert.ok(Number.isFinite(f.intensity) && f.intensity >= 0 && f.intensity <= 1);
    assert.ok(Number.isFinite(f.rate));
    assert.doesNotThrow(() => tracker.snapshot());
    assert.doesNotThrow(() => tracker.record({ key: B, source: 'you', weight: 1 }));
  });

  it('an older explicit `at` never moves lastEditAt backwards (late-arriving events)', () => {
    const { tracker } = setup();
    tracker.record({ key: A, source: 'you', weight: 1, at: T0 + 100 });
    tracker.record({ key: A, source: 'you', weight: 1, at: T0 + 40 });
    const f = must(tracker.get(A));
    assert.equal(f.lastEditAt, T0 + 100);
    assert.equal(f.firstEditAt, T0 + 100, 'firstEditAt is the first ACCEPTED event, not the smallest timestamp');
    assert.equal(f.editCount, 2);
  });

  it('retains at most MAX_EVENTS_PER_FILE events (oldest dropped) while editCount is lifetime', () => {
    const { clock, tracker } = setup();
    // 100 very heavy old events followed by 512 light ones; only the 512 newest may remain.
    for (let k = 1; k <= 100; k++) tracker.record({ key: A, source: 'you', weight: 1000, at: T0 + k });
    for (let k = 1; k <= K.MAX_EVENTS_PER_FILE; k++) tracker.record({ key: A, source: 'you', weight: 1, at: T0 + 100 + k });
    clock.set(T0 + 100 + K.MAX_EVENTS_PER_FILE);
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 100 + K.MAX_EVENTS_PER_FILE);
    // 512 weight over a 511 ms span (floored to 500 ms minimum): about 1002/s. If the heavy events survived it would be > 100000.
    assert.ok(f.rate < 2000, `rate ${f.rate} suggests more than MAX_EVENTS_PER_FILE events were retained`);
    assert.ok(f.rate > 900, `rate ${f.rate} suggests events were dropped that should have been kept`);
  });

  it('survives 10,000 events on one file with bounded effect on the rate', () => {
    const { tracker } = setup();
    for (let i = 0; i < 10_000; i++) tracker.record({ key: A, source: 'you', weight: 1 });
    const f = must(tracker.get(A));
    assert.equal(f.editCount, 10_000);
    assert.ok(f.rate <= (K.MAX_EVENTS_PER_FILE / (K.MIN_SPAN_MS / 1000)) + 1e-6, `rate ${f.rate}`);
  });
});
