import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeWeight,
  clamp01,
  clampSensitivity,
  editIntensity,
  idleFade,
  rateToIntensity,
  referenceIntensity,
  shakeParams,
  typingWeight,
  windowRate,
} from '../../src/core/intensity';
import type { WeightedEvent } from '../../src/core/intensity';
import { K } from '../../src/core/constants';

const TOL = 1e-3;
function near(actual: number, expected: number, tol = TOL, msg = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected} +/- ${tol}, got ${actual}`,
  );
}

const T0 = 1_000_000;
const OPTS = { windowMs: 3000, idleTimeoutMs: 2500, sensitivity: 1 };

describe('clamp01 / clampSensitivity', () => {
  it('clamp01 maps non-finite to 0 (including +Infinity) and clamps the rest', () => {
    assert.equal(clamp01(Number.NaN), 0);
    assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
    assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clamp01(-0.0001), 0);
    assert.equal(clamp01(-5), 0);
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(0.25), 0.25);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(1.0001), 1);
    assert.equal(clamp01(1e300), 1);
  });

  it('clampSensitivity maps non-finite to 1 and clamps to [0.25, 4]', () => {
    assert.equal(clampSensitivity(Number.NaN), 1);
    assert.equal(clampSensitivity(Number.POSITIVE_INFINITY), 1);
    assert.equal(clampSensitivity(Number.NEGATIVE_INFINITY), 1);
    assert.equal(clampSensitivity(0), 0.25);
    assert.equal(clampSensitivity(-3), 0.25);
    assert.equal(clampSensitivity(0.25), 0.25);
    assert.equal(clampSensitivity(1), 1);
    assert.equal(clampSensitivity(2.5), 2.5);
    assert.equal(clampSensitivity(4), 4);
    assert.equal(clampSensitivity(100), 4);
  });
});

describe('changeWeight (DESIGN 6 worked table)', () => {
  const table: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [2, 2],
    [4, 3],
    [8, 4],
    [50, 6.644],
    [500, 9.966],
    [4095, 12],
    [1e5, 12],
  ];
  for (const [chars, expected] of table) {
    it(`changeWeight(${chars}) = ${expected}`, () => {
      near(changeWeight(chars), expected, 1e-3);
    });
  }

  it('is 0 for negative, NaN and Infinity input and never throws', () => {
    assert.equal(changeWeight(-1), 0);
    assert.equal(changeWeight(-1e9), 0);
    assert.equal(changeWeight(Number.NaN), 0);
    assert.equal(changeWeight(Number.POSITIVE_INFINITY), 0);
    assert.equal(changeWeight(Number.NEGATIVE_INFINITY), 0);
  });

  it('never exceeds MAX_EVENT_WEIGHT and is monotonic', () => {
    let prev = 0;
    for (let c = 0; c <= 20000; c += 7) {
      const w = changeWeight(c);
      assert.ok(w >= prev - 1e-12, `monotonic at ${c}`);
      assert.ok(w <= K.MAX_EVENT_WEIGHT);
      prev = w;
    }
  });
});

describe('typingWeight', () => {
  it('is 0 for no changes', () => {
    assert.equal(typingWeight([]), 0);
  });

  it('one single-character insert is weight 1', () => {
    assert.equal(typingWeight([{ inserted: 1, deleted: 0 }]), 1);
  });

  it('uses max(inserted, deleted) per change', () => {
    near(typingWeight([{ inserted: 4, deleted: 50 }]), changeWeight(50));
    near(typingWeight([{ inserted: 50, deleted: 4 }]), changeWeight(50));
    near(typingWeight([{ inserted: 0, deleted: 1 }]), 1);
  });

  it('sums the changes (multi-cursor typing)', () => {
    near(typingWeight([{ inserted: 1, deleted: 0 }, { inserted: 1, deleted: 0 }, { inserted: 1, deleted: 0 }]), 3);
    near(typingWeight([{ inserted: 4, deleted: 0 }, { inserted: 8, deleted: 0 }]), 3 + 4);
  });

  it('caps the total at MAX_EVENT_WEIGHT', () => {
    const many = Array.from({ length: 100 }, () => ({ inserted: 100, deleted: 0 }));
    assert.equal(typingWeight(many), K.MAX_EVENT_WEIGHT);
    assert.equal(typingWeight([{ inserted: 1e7, deleted: 0 }]), K.MAX_EVENT_WEIGHT);
  });

  it('ignores zero-size and garbage changes without throwing', () => {
    assert.equal(typingWeight([{ inserted: 0, deleted: 0 }]), 0);
    assert.equal(typingWeight([{ inserted: Number.NaN, deleted: Number.NaN }]), 0);
    assert.equal(typingWeight([{ inserted: -5, deleted: -5 }]), 0);
  });
});

describe('windowRate', () => {
  const ev = (at: number, weight: number): WeightedEvent => ({ at, weight });

  it('is 0 with no events', () => {
    assert.equal(windowRate([], T0, 3000), 0);
  });

  it('a single weight-1 event has rate 2/s at its own instant (span floored at MIN_SPAN_MS)', () => {
    near(windowRate([ev(T0, 1)], T0, 3000), 2, 1e-9);
  });

  it('DESIGN 6 table: 1 keystroke, rate over time', () => {
    const rows: Array<[number, number]> = [
      [0, 2],
      [250, 2],
      [500, 2],
      [1000, 1],
      [1500, 0.667],
      [2000, 0.5],
      [2499, 0.4],
      [2500, 0.4],
    ];
    for (const [dt, rate] of rows) {
      near(windowRate([ev(T0, 1)], T0 + dt, 3000), rate, 1e-3, `dt=${dt}`);
    }
  });

  it('15 keystrokes at 200ms spacing, now = T0+3000 -> rate 5.357 (span 2800)', () => {
    const events = Array.from({ length: 15 }, (_, i) => ev(T0 + 200 * (i + 1), 1));
    near(windowRate(events, T0 + 3000, 3000), 15 / 2.8, 1e-9);
    near(windowRate(events, T0 + 3000, 3000), 5.357, 1e-3);
  });

  it('an event exactly windowMs old is no longer live (strict <)', () => {
    assert.equal(windowRate([ev(T0, 1)], T0 + 3000, 3000), 0);
    assert.ok(windowRate([ev(T0, 1)], T0 + 2999, 3000) > 0);
  });

  it('events in the future (at > now) are ignored', () => {
    assert.equal(windowRate([ev(T0 + 10, 5)], T0, 3000), 0);
    near(windowRate([ev(T0 - 100, 1), ev(T0 + 500, 50)], T0, 3000), 1 / 0.5, 1e-9);
  });

  it('span is measured from the oldest LIVE event and floored/capped by [MIN_SPAN_MS, windowMs]', () => {
    // oldest live event 2000ms ago, weights 1+1 -> 2 / 2s = 1
    near(windowRate([ev(T0 - 2000, 1), ev(T0, 1)], T0, 3000), 1, 1e-9);
    // an event older than the window does not stretch the span
    near(windowRate([ev(T0 - 5000, 100), ev(T0 - 1000, 1)], T0, 3000), 1, 1e-9);
    // span never exceeds windowMs even when the oldest live event is just inside it
    near(windowRate([ev(T0 - 2999, 3)], T0, 3000), 3 / 2.999, 1e-9);
  });

  it('a NaN clock matches no events and yields 0 without throwing', () => {
    assert.equal(windowRate([ev(T0, 1)], Number.NaN, 3000), 0);
  });
});

describe('rateToIntensity (DESIGN 6 table)', () => {
  const rates: Array<[number, number]> = [
    [0, 0],
    [0.1, 0.12],
    [0.5, 0.12],
    [1, 0.1535],
    [2, 0.2835],
    [3, 0.3935],
    [5, 0.5654],
    [6, 0.6321],
    [10, 0.8111],
    [12, 0.8647],
    [20, 0.9643],
    [60, 1.0],
  ];
  for (const [rate, expected] of rates) {
    it(`rate ${rate} @ sensitivity 1 -> ${expected}`, () => {
      near(rateToIntensity(rate, 1), expected);
    });
  }

  const sens: Array<[number, number]> = [
    [0.25, 0.1881],
    [0.5, 0.3408],
    [1, 0.5654],
    [2, 0.8111],
    [4, 0.9643],
    [Number.NaN, 0.5654],
    [100, 0.9643],
  ];
  for (const [s, expected] of sens) {
    it(`rate 5 @ sensitivity ${s} -> ${expected}`, () => {
      near(rateToIntensity(5, s), expected);
    });
  }

  it('non-positive and non-finite rates give exactly 0, never throw', () => {
    for (const r of [0, -0, -1, -1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(rateToIntensity(r, 1), 0, `rate=${r}`);
    }
  });

  it('any positive finite rate is at least FLOOR and at most 1', () => {
    for (const r of [1e-9, 1e-3, 0.01, 0.1, 1, 100, 1e9, Number.MAX_VALUE]) {
      const i = rateToIntensity(r, 1);
      assert.ok(i >= K.FLOOR && i <= 1, `rate=${r} -> ${i}`);
    }
  });

  it('is monotonic non-decreasing in rate and in sensitivity', () => {
    let prev = 0;
    for (let r = 0; r <= 40; r += 0.25) {
      const i = rateToIntensity(r, 1);
      assert.ok(i >= prev - 1e-12);
      prev = i;
    }
    let prevS = 0;
    for (const s of [0.25, 0.5, 1, 2, 4]) {
      const i = rateToIntensity(4, s);
      assert.ok(i >= prevS - 1e-12);
      prevS = i;
    }
  });
});

describe('idleFade', () => {
  it('linear from 1 to 0 over the idle timeout', () => {
    assert.equal(idleFade(0, 2500), 1);
    near(idleFade(250, 2500), 0.9, 1e-12);
    near(idleFade(1250, 2500), 0.5, 1e-12);
    assert.equal(idleFade(2500, 2500), 0);
    assert.equal(idleFade(9999, 2500), 0);
  });

  it('negative since is floored at 0 (clock moved backwards)', () => {
    assert.equal(idleFade(-500, 2500), 1);
  });

  it('idle <= 0 gives 0', () => {
    assert.equal(idleFade(0, 0), 0);
    assert.equal(idleFade(100, -5), 0);
  });

  it('NaN never leaks out as NaN', () => {
    assert.ok(!Number.isNaN(idleFade(Number.NaN, 2500)));
    assert.ok(!Number.isNaN(idleFade(10, Number.NaN)));
  });
});

describe('editIntensity (DESIGN 6 worked examples)', () => {
  it('empty events -> 0', () => {
    assert.equal(editIntensity([], T0, OPTS), 0);
  });

  it('1 keystroke: intensity over time', () => {
    const events = [{ at: T0, weight: 1 }];
    const rows: Array<[number, number]> = [
      [0, 0.2835],
      [250, 0.2551],
      [500, 0.2268],
      [1000, 0.0921],
      [1500, 0.048],
      [2000, 0.024],
    ];
    for (const [dt, expected] of rows) {
      near(editIntensity(events, T0 + dt, OPTS), expected, TOL, `dt=${dt}`);
    }
    assert.ok(editIntensity(events, T0 + 2499, OPTS) < 0.001, 'dt=2499 is below 0.001');
    assert.ok(editIntensity(events, T0 + 2499, OPTS) > 0, 'dt=2499 is still positive (active)');
    assert.equal(editIntensity(events, T0 + 2500, OPTS), 0, 'dt=2500 is exactly the idle boundary');
    assert.equal(editIntensity(events, T0 + 99999, OPTS), 0);
  });

  it('15 keystrokes at 5/s, now = T0+3000 -> 0.5905', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({ at: T0 + 200 * (i + 1), weight: 1 }));
    near(editIntensity(events, T0 + 3000, OPTS), 0.5905);
  });

  it('paste of 500 chars (w=9.966): intensity over time', () => {
    const w = changeWeight(500);
    const events = [{ at: T0, weight: w }];
    const rows: Array<[number, number]> = [
      [0, 0.9639],
      [500, 0.7711],
      [1000, 0.486],
      [2000, 0.1128],
      [2500, 0],
    ];
    for (const [dt, expected] of rows) {
      near(editIntensity(events, T0 + dt, OPTS), expected, TOL, `dt=${dt}`);
    }
  });

  it('external write (w=6): intensity over time', () => {
    const events = [{ at: T0, weight: K.EXTERNAL_EVENT_WEIGHT }];
    const rows: Array<[number, number]> = [
      [0, 0.8647],
      [500, 0.6917],
      [1000, 0.3793],
      [1250, 0.2753],
      [2000, 0.0787],
      [2500, 0],
    ];
    for (const [dt, expected] of rows) {
      near(editIntensity(events, T0 + dt, OPTS), expected, TOL, `dt=${dt}`);
    }
  });

  it('a tiny windowMs never zeroes an active file (effective window = max(windowMs, idleTimeoutMs))', () => {
    const events = [{ at: T0, weight: 1 }];
    const tiny = { windowMs: 500, idleTimeoutMs: 2500, sensitivity: 1 };
    const i = editIntensity(events, T0 + 2000, tiny);
    assert.ok(i > 0, `intensity ${i} must stay > 0 while active`);
    near(i, K.FLOOR * 0.2, 1e-9);
  });

  it('sensitivity scales the result up and down', () => {
    const events = [{ at: T0, weight: 1 }];
    const lo = editIntensity(events, T0, { ...OPTS, sensitivity: 0.25 });
    const mid = editIntensity(events, T0, OPTS);
    const hi = editIntensity(events, T0, { ...OPTS, sensitivity: 4 });
    assert.ok(lo <= mid && mid <= hi);
    assert.ok(hi > lo);
  });

  it('events in the future yield a finite value in [0,1] and do not throw', () => {
    const i = editIntensity([{ at: T0 + 5000, weight: 5 }], T0, OPTS);
    assert.ok(Number.isFinite(i) && i >= 0 && i <= 1);
  });

  it('garbage options never produce NaN or out-of-range values', () => {
    const events = [{ at: T0, weight: 3 }];
    for (const o of [
      { windowMs: Number.NaN, idleTimeoutMs: 2500, sensitivity: 1 },
      { windowMs: 3000, idleTimeoutMs: Number.NaN, sensitivity: 1 },
      { windowMs: 3000, idleTimeoutMs: 2500, sensitivity: Number.NaN },
      { windowMs: -1, idleTimeoutMs: -1, sensitivity: -1 },
      { windowMs: 0, idleTimeoutMs: 0, sensitivity: 0 },
    ]) {
      const i = editIntensity(events, T0 + 10, o);
      assert.ok(i >= 0 && i <= 1, JSON.stringify(o));
    }
  });
});

describe('referenceIntensity (DESIGN 6 table)', () => {
  const rows: Array<[number, number]> = [
    [0, 0],
    [1, 0.1982],
    [2, 0.3142],
    [3, 0.3965],
    [5, 0.5124],
    [7, 0.5947],
    [10, 0.6858],
    [15, 0.793],
    [31, 0.9912],
    [32, 1],
    [100, 1],
  ];
  for (const [count, expected] of rows) {
    it(`count ${count} @ sensitivity 1 -> ${expected}`, () => {
      near(referenceIntensity(count, 1), expected);
    });
  }

  const rows2: Array<[number, number]> = [
    [1, 0.3965],
    [3, 0.793],
    [7, 1],
    [15, 1],
  ];
  for (const [count, expected] of rows2) {
    it(`count ${count} @ sensitivity 2 -> ${expected}`, () => {
      near(referenceIntensity(count, 2), expected);
    });
  }

  it('non-positive / non-finite counts give exactly 0', () => {
    for (const c of [0, -1, -100, Number.NaN, Number.NEGATIVE_INFINITY]) {
      assert.equal(referenceIntensity(c, 1), 0, `count=${c}`);
    }
  });

  it('is within [0,1] and never NaN for odd inputs', () => {
    for (const c of [1e12, Number.MAX_VALUE, Number.POSITIVE_INFINITY]) {
      const i = referenceIntensity(c, 1);
      assert.ok(i >= 0 && i <= 1 && !Number.isNaN(i), `count=${c} -> ${i}`);
    }
    assert.ok(referenceIntensity(5, Number.NaN) > 0);
    near(referenceIntensity(5, Number.NaN), referenceIntensity(5, 1));
  });

  it('is monotonic in count', () => {
    let prev = 0;
    for (let c = 0; c <= 64; c++) {
      const i = referenceIntensity(c, 1);
      assert.ok(i >= prev - 1e-12);
      prev = i;
    }
  });
});

describe('shakeParams (exact values)', () => {
  const rows: Array<[number, { amp: number; dur: number; rot: number }]> = [
    [0, { amp: 0, dur: 160, rot: 0 }],
    [0.1, { amp: 0.85, dur: 150, rot: 0.3 }],
    [0.25, { amp: 1.38, dur: 135, rot: 0.45 }],
    [0.5, { amp: 2.25, dur: 110, rot: 0.7 }],
    [0.75, { amp: 3.13, dur: 85, rot: 0.95 }],
    [1, { amp: 4, dur: 60, rot: 1.2 }],
  ];
  for (const [i, expected] of rows) {
    it(`shakeParams(${i})`, () => {
      assert.deepEqual(shakeParams(i), expected);
    });
  }

  it('shakeParams(referenceIntensity(5,1)) = {2.29, 109, 0.71}', () => {
    assert.deepEqual(shakeParams(referenceIntensity(5, 1)), { amp: 2.29, dur: 109, rot: 0.71 });
  });

  it('values above 1 are clamped: shakeParams(5) == shakeParams(1)', () => {
    assert.deepEqual(shakeParams(5), shakeParams(1));
    assert.deepEqual(shakeParams(1e9), shakeParams(1));
  });

  it('<= 0 and non-finite inputs give the zero shake and never throw', () => {
    const zero = { amp: 0, dur: 160, rot: 0 };
    for (const i of [0, -0, -0.5, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.deepEqual(shakeParams(i), zero, `i=${i}`);
    }
  });

  it('amp is non-decreasing, dur non-increasing and rot non-decreasing across the range', () => {
    let prev = shakeParams(0.001);
    for (let i = 0.002; i <= 1.0001; i += 0.002) {
      const s = shakeParams(i);
      assert.ok(s.amp >= prev.amp - 1e-9, `amp at ${i}`);
      assert.ok(s.dur <= prev.dur, `dur at ${i}`);
      assert.ok(s.rot >= prev.rot - 1e-9, `rot at ${i}`);
      assert.ok(s.amp >= 0.5 && s.amp <= 4, `amp range at ${i}`);
      assert.ok(s.dur >= 60 && s.dur <= 160);
      assert.ok(s.rot >= 0.2 && s.rot <= 1.2);
      prev = s;
    }
  });

  it('amp and rot are rounded to 2 decimals, dur to an integer', () => {
    for (let i = 0.01; i <= 1; i += 0.0137) {
      const s = shakeParams(i);
      assert.equal(Math.round(s.amp * 100) / 100, s.amp);
      assert.equal(Math.round(s.rot * 100) / 100, s.rot);
      assert.ok(Number.isInteger(s.dur));
    }
  });
});
