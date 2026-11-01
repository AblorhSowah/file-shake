import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { K } from '../../src/core/constants';

// DESIGN 5, literally. Other tests compare against K.* so they would not notice a changed constant.
const DESIGN_5: Record<string, number> = {
  RATE_SCALE: 6,
  FLOOR: 0.12,
  MIN_SPAN_MS: 500,
  MAX_EVENT_WEIGHT: 12,
  EXTERNAL_EVENT_WEIGHT: 6,
  EXTERNAL_DEDUPE_MS: 300,
  SELF_SAVE_WINDOW_MS: 2000,
  RETAIN_AFTER_IDLE_MS: 4000,
  REF_SATURATION: 32,
  MAX_REFERENCE_SOURCES: 3,
  MAX_REFS_PER_SOURCE: 30,
  MAX_STATEMENTS: 2000,
  REF_DEBOUNCE_MS: 400,
  MAX_PROBES: 400,
  ANALYSIS_TIMEOUT_MS: 1500,
  TICK_MS: 200,
  BURST_LIMIT: 30,
  BURST_WINDOW_MS: 1000,
  BURST_COOLDOWN_MS: 3000,
  LEAVE_MS: 400,
  EVENT_LOG_SIZE: 50,
  AMP_MIN: 0.5,
  AMP_RANGE: 3.5,
  DUR_BASE: 160,
  DUR_RANGE: 100,
  ROT_BASE: 0.2,
  ROT_RANGE: 1.0,
  MAX_EVENTS_PER_FILE: 512,
};

describe('constants (DESIGN 5)', () => {
  for (const [name, value] of Object.entries(DESIGN_5)) {
    it(`K.${name} = ${value}`, () => {
      assert.equal((K as Record<string, unknown>)[name], value);
    });
  }

  it('there are no undocumented numeric tunables hiding in K', () => {
    const extra = Object.keys(K).filter((k) => !(k in DESIGN_5) && typeof (K as Record<string, unknown>)[k] === 'number');
    assert.deepEqual(extra, []);
  });
});
