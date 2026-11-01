import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDocumentChange, classifyWatcherEvent } from '../../src/core/sourceClassifier';
import type { DocChangeContext } from '../../src/core/sourceClassifier';
import { BurstGuard } from '../../src/core/burstGuard';
import { ManualClock } from '../../src/core/clock';
import { K } from '../../src/core/constants';

const base: DocChangeContext = {
  contentChangeCount: 1,
  isSaving: false,
  reason: undefined,
  isDirtyAfter: true,
  isActiveEditorDoc: true,
  windowFocused: true,
};
const ctx = (o: Partial<DocChangeContext>): DocChangeContext => ({ ...base, ...o });

describe('classifyDocumentChange: the six rows of DESIGN 7.3', () => {
  it('row 1: no content changes -> ignore / no-content-change', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ contentChangeCount: 0 })), { decision: 'ignore', reason: 'no-content-change' });
  });

  it('row 2: saving -> ignore / saving (format-on-save edits)', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ isSaving: true })), { decision: 'ignore', reason: 'saving' });
  });

  it('row 3: undo and redo -> you / undo-redo', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ reason: 'undo' })), { decision: 'you', reason: 'undo-redo' });
    assert.deepEqual(classifyDocumentChange(ctx({ reason: 'redo' })), { decision: 'you', reason: 'undo-redo' });
  });

  it('row 4: not dirty after the change (disk reload / revert) -> external / reload-from-disk', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ isDirtyAfter: false })), { decision: 'external', reason: 'reload-from-disk' });
  });

  it('row 5: focused editor document in a focused window -> you / active-focused-edit', () => {
    assert.deepEqual(classifyDocumentChange(ctx({})), { decision: 'you', reason: 'active-focused-edit' });
  });

  it('row 6a: dirty but not the active editor -> external / background-edit', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ isActiveEditorDoc: false })), { decision: 'external', reason: 'background-edit' });
  });

  it('row 6b: active editor document but window not focused -> external / background-edit', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ windowFocused: false })), { decision: 'external', reason: 'background-edit' });
  });
});

describe('classifyDocumentChange: precedence', () => {
  it('"Undo to clean state" is you / undo-redo, NOT a reload (row 3 beats row 4)', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ reason: 'undo', isDirtyAfter: false })), { decision: 'you', reason: 'undo-redo' });
    assert.deepEqual(classifyDocumentChange(ctx({ reason: 'redo', isDirtyAfter: false })), { decision: 'you', reason: 'undo-redo' });
  });

  it('empty changes beat everything', () => {
    assert.equal(
      classifyDocumentChange(ctx({ contentChangeCount: 0, isSaving: true, reason: 'undo', isDirtyAfter: false })).reason,
      'no-content-change',
    );
  });

  it('saving beats undo/redo, reload and focus', () => {
    assert.equal(classifyDocumentChange(ctx({ isSaving: true, reason: 'undo' })).reason, 'saving');
    assert.equal(classifyDocumentChange(ctx({ isSaving: true, isDirtyAfter: false })).reason, 'saving');
  });

  it('reload (not dirty) beats the focused-editor rule', () => {
    assert.deepEqual(classifyDocumentChange(ctx({ isDirtyAfter: false, isActiveEditorDoc: true, windowFocused: true })), {
      decision: 'external',
      reason: 'reload-from-disk',
    });
  });

  it('undo while the window is unfocused is still you (an undo is a user gesture)', () => {
    assert.equal(classifyDocumentChange(ctx({ reason: 'undo', windowFocused: false, isActiveEditorDoc: false })).decision, 'you');
  });

  it('exhaustive: 144 combinations match the decision table', () => {
    const reference = (c: DocChangeContext): { decision: string; reason: string } => {
      if (c.contentChangeCount === 0) return { decision: 'ignore', reason: 'no-content-change' };
      if (c.isSaving) return { decision: 'ignore', reason: 'saving' };
      if (c.reason === 'undo' || c.reason === 'redo') return { decision: 'you', reason: 'undo-redo' };
      if (!c.isDirtyAfter) return { decision: 'external', reason: 'reload-from-disk' };
      if (c.isActiveEditorDoc && c.windowFocused) return { decision: 'you', reason: 'active-focused-edit' };
      return { decision: 'external', reason: 'background-edit' };
    };
    let n = 0;
    for (const contentChangeCount of [0, 1, 5]) {
      for (const isSaving of [false, true]) {
        for (const reason of ['undo', 'redo', undefined] as const) {
          for (const isDirtyAfter of [false, true]) {
            for (const isActiveEditorDoc of [false, true]) {
              for (const windowFocused of [false, true]) {
                const c: DocChangeContext = { contentChangeCount, isSaving, reason, isDirtyAfter, isActiveEditorDoc, windowFocused };
                assert.deepEqual(classifyDocumentChange(c), reference(c), JSON.stringify(c));
                n++;
              }
            }
          }
        }
      }
    }
    assert.equal(n, 144);
  });
});

describe('classifyWatcherEvent', () => {
  it('no save seen -> external / disk-write', () => {
    assert.deepEqual(classifyWatcherEvent({ msSinceOwnSave: undefined }), { decision: 'external', reason: 'disk-write' });
  });

  it('within SELF_SAVE_WINDOW_MS of our own save -> ignore / self-save', () => {
    for (const ms of [0, 1, 500, K.SELF_SAVE_WINDOW_MS - 1]) {
      assert.deepEqual(classifyWatcherEvent({ msSinceOwnSave: ms }), { decision: 'ignore', reason: 'self-save' }, `ms=${ms}`);
    }
  });

  it('at or after SELF_SAVE_WINDOW_MS -> external / disk-write (strict <)', () => {
    for (const ms of [K.SELF_SAVE_WINDOW_MS, K.SELF_SAVE_WINDOW_MS + 1, 60_000]) {
      assert.deepEqual(classifyWatcherEvent({ msSinceOwnSave: ms }), { decision: 'external', reason: 'disk-write' }, `ms=${ms}`);
    }
  });

  it('a negative msSinceOwnSave (clock skew) is treated as "just saved"', () => {
    assert.equal(classifyWatcherEvent({ msSinceOwnSave: -5 }).decision, 'ignore');
  });
});

describe('BurstGuard', () => {
  const key = (i: number): string => `/ws/f${i}.ts`;

  it('accepts up to BURST_LIMIT distinct files in a window, then trips', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i < K.BURST_LIMIT; i++) assert.equal(g.accept(key(i)), true, `file ${i}`);
    assert.equal(g.accept(key(K.BURST_LIMIT)), false, 'the 31st distinct file trips the guard');
  });

  it('while in cooldown everything is rejected, even files already seen', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i <= K.BURST_LIMIT; i++) g.accept(key(i));
    clock.advance(K.BURST_COOLDOWN_MS - 1);
    assert.equal(g.accept(key(0)), false);
    assert.equal(g.accept('/ws/brand-new.ts'), false);
  });

  it('recovers after the cooldown', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i <= K.BURST_LIMIT; i++) g.accept(key(i));
    clock.advance(K.BURST_COOLDOWN_MS + K.BURST_WINDOW_MS + 1);
    assert.equal(g.accept('/ws/after.ts'), true);
    assert.equal(g.accept(key(0)), true);
  });

  it('the same key repeated does not count against the limit', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i < 500; i++) assert.equal(g.accept('/ws/same.ts'), true);
    // and it did not use up the budget for other files
    for (let i = 0; i < K.BURST_LIMIT - 1; i++) assert.equal(g.accept(key(i)), true);
  });

  it('at the limit, an already-seen key is still accepted and does not trip the guard; only a NEW key does', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i < K.BURST_LIMIT; i++) assert.equal(g.accept(key(i)), true);
    assert.equal(g.accept(key(0)), true, 'a repeat of a known key is not a new file');
    assert.equal(g.accept(key(K.BURST_LIMIT - 1)), true);
    assert.equal(g.accept(key(K.BURST_LIMIT)), false, 'the first NEW key beyond the limit trips it');
  });

  it('the window slides: old keys stop counting after BURST_WINDOW_MS', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i < K.BURST_LIMIT; i++) g.accept(key(i));
    clock.advance(K.BURST_WINDOW_MS + 1);
    for (let i = 100; i < 100 + K.BURST_LIMIT; i++) assert.equal(g.accept(key(i)), true, `file ${i}`);
  });

  it('a slow trickle of distinct files never trips it', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    for (let i = 0; i < 300; i++) {
      clock.advance(100); // 10 files per second
      assert.equal(g.accept(key(i)), true, `file ${i}`);
    }
  });

  it('DESIGN 12: 100 files touched within 1 s -> exactly BURST_LIMIT are accepted, the flood is suppressed', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock);
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (g.accept(key(i))) accepted++;
      clock.advance(9);
    }
    assert.equal(accepted, K.BURST_LIMIT);
  });

  it('custom limit / window / cooldown are honoured', () => {
    const clock = new ManualClock(0);
    const g = new BurstGuard(clock, 3, 100, 500);
    assert.equal(g.accept('/a'), true);
    assert.equal(g.accept('/b'), true);
    assert.equal(g.accept('/c'), true);
    assert.equal(g.accept('/d'), false);
    clock.advance(499);
    assert.equal(g.accept('/e'), false);
    clock.advance(600);
    assert.equal(g.accept('/f'), true);
  });
});
