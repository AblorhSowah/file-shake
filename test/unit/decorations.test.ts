import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecorations, changedKeys } from '../../src/core/decorations';
import { viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import type { DecorationSpec, FileKey, ViewRow } from '../support/types';

const OPTS = { showWhenIdle: false, decorateFolders: true };
const ref = (key: string, refCount: number, o: Partial<ViewRow> = {}): ViewRow =>
  viewRow(key, { role: 'referenced', source: null, refCount, badge: `×${refCount} refs`, tooltip: `Referenced ${refCount}× by a.ts`, ...o });

describe('buildDecorations', () => {
  it('edited by you -> "●" in the edited colour; external -> "◆"', () => {
    const m = buildDecorations([viewRow('/ws/a.ts'), viewRow('/ws/b.ts', { source: 'external' })], OPTS);
    const a = must(m.get('/ws/a.ts'));
    assert.equal(a.badge, '●');
    assert.equal(a.colorId, 'fileShake.editedForeground');
    assert.equal(a.role, 'edited');
    const b = must(m.get('/ws/b.ts'));
    assert.equal(b.badge, '◆');
    assert.equal(b.colorId, 'fileShake.editedForeground');
  });

  it('referenced -> decimal count in the referenced colour, "9+" from 10', () => {
    const rows = [1, 2, 5, 9, 10, 11, 100, 100000].map((n) => ref(`/ws/r${n}.ts`, n));
    const m = buildDecorations(rows, OPTS);
    const badge = (n: number): string => must(m.get(`/ws/r${n}.ts`)).badge;
    assert.deepEqual([1, 2, 5, 9].map(badge), ['1', '2', '5', '9']);
    assert.deepEqual([10, 11, 100, 100000].map(badge), ['9+', '9+', '9+', '9+']);
    for (const n of [1, 10]) {
      const spec = must(m.get(`/ws/r${n}.ts`));
      assert.equal(spec.colorId, 'fileShake.referencedForeground');
      assert.equal(spec.role, 'referenced');
    }
  });

  it('every badge is at most 2 UTF-16 code units (the VS Code limit) for any plausible input', () => {
    const rows: ViewRow[] = [viewRow('/ws/y.ts'), viewRow('/ws/e.ts', { source: 'external' })];
    for (let n = 0; n <= 2000; n += 1) rows.push(ref(`/ws/r${n}.ts`, n));
    rows.push(ref('/ws/nan.ts', Number.NaN), ref('/ws/inf.ts', Number.POSITIVE_INFINITY), ref('/ws/neg.ts', -5), ref('/ws/frac.ts', 3.7));
    const m = buildDecorations(rows, { showWhenIdle: true, decorateFolders: false });
    assert.ok(m.size > 0);
    for (const [key, spec] of m) {
      assert.ok(spec.badge.length <= 2, `${key}: badge ${JSON.stringify(spec.badge)} has length ${spec.badge.length}`);
      assert.ok(spec.badge.length >= 1 || spec.tooltip.length > 0, `${key}: a decoration needs a badge, tooltip or colour`);
    }
  });

  it('tooltips carry the "File Shake: " prefix', () => {
    const m = buildDecorations([viewRow('/ws/a.ts'), ref('/ws/b.ts', 3)], OPTS);
    for (const spec of m.values()) assert.ok(spec.tooltip.startsWith('File Shake: '), spec.tooltip);
  });

  it('propagate follows decorateFolders', () => {
    const rows = [viewRow('/ws/a.ts'), ref('/ws/b.ts', 3)];
    for (const spec of buildDecorations(rows, { showWhenIdle: false, decorateFolders: true }).values()) assert.equal(spec.propagate, true);
    for (const spec of buildDecorations(rows, { showWhenIdle: false, decorateFolders: false }).values()) assert.equal(spec.propagate, false);
  });

  it('idle (retained / fading) rows get no decoration unless showWhenIdle', () => {
    const rows = [viewRow('/ws/a.ts', { phase: 'idle', intensity: 0 }), ref('/ws/b.ts', 3, { phase: 'idle', intensity: 0 }), viewRow('/ws/live.ts')];
    const hidden = buildDecorations(rows, { showWhenIdle: false, decorateFolders: true });
    assert.deepEqual([...hidden.keys()], ['/ws/live.ts']);
    const shown = buildDecorations(rows, { showWhenIdle: true, decorateFolders: true });
    assert.deepEqual([...shown.keys()].sort(), ['/ws/a.ts', '/ws/b.ts', '/ws/live.ts']);
  });

  it('is keyed by the row id (the FileKey), so two roots with the same file name stay distinct', () => {
    const m = buildDecorations([viewRow('/w/a/x.ts'), viewRow('/w/b/x.ts')], OPTS);
    assert.deepEqual([...m.keys()].sort(), ['/w/a/x.ts', '/w/b/x.ts']);
  });

  it('no rows -> empty map', () => {
    assert.equal(buildDecorations([], OPTS).size, 0);
  });

  it('decorations carry no intensity: rows that differ only in intensity/shake give identical specs', () => {
    const a = buildDecorations([viewRow('/ws/a.ts', { intensity: 0.2, shake: { amp: 1, dur: 150, rot: 0.3 } }), ref('/ws/b.ts', 3, { intensity: 0.2 })], OPTS);
    const b = buildDecorations([viewRow('/ws/a.ts', { intensity: 0.95, shake: { amp: 4, dur: 61, rot: 1.2 } }), ref('/ws/b.ts', 3, { intensity: 0.95 })], OPTS);
    assert.deepEqual([...a.entries()], [...b.entries()]);
    assert.deepEqual(changedKeys(a, b), [], 'keystrokes alone must not fire onDidChangeFileDecorations');
  });

  it('design intent (DESIGN 1/10): the per-edit counter in the row tooltip must not make the decoration change on every keystroke', () => {
    const a = buildDecorations([viewRow('/ws/a.ts', { tooltip: 'Edited by you (typing) · 3 edits' })], OPTS);
    const b = buildDecorations([viewRow('/ws/a.ts', { tooltip: 'Edited by you (typing) · 4 edits' })], OPTS);
    assert.deepEqual(changedKeys(a, b), [], 'decoration tooltip must not embed the edit counter');
  });
});

describe('changedKeys', () => {
  const spec = (o: Partial<DecorationSpec> = {}): DecorationSpec => ({
    role: 'edited',
    badge: '●',
    tooltip: 'File Shake: edited',
    colorId: 'fileShake.editedForeground',
    propagate: true,
    ...o,
  });
  const map = (entries: Array<[FileKey, DecorationSpec]>): Map<FileKey, DecorationSpec> => new Map(entries);

  it('identical maps (even with distinct but deep-equal spec objects) -> []', () => {
    assert.deepEqual(changedKeys(map([['/a', spec()]]), map([['/a', spec()]])), []);
    assert.deepEqual(changedKeys(new Map(), new Map()), []);
  });

  it('added keys', () => {
    assert.deepEqual(changedKeys(new Map(), map([['/a', spec()], ['/b', spec()]])).sort(), ['/a', '/b']);
  });

  it('removed keys', () => {
    assert.deepEqual(changedKeys(map([['/a', spec()], ['/b', spec()]]), map([['/b', spec()]])), ['/a']);
  });

  it('changed specs, one field at a time', () => {
    const base = map([['/a', spec()]]);
    for (const patch of [
      { badge: '◆' },
      { tooltip: 'File Shake: other' },
      { colorId: 'fileShake.referencedForeground' as const },
      { propagate: false },
      { role: 'referenced' as const },
    ]) {
      assert.deepEqual(changedKeys(base, map([['/a', spec(patch)]])), ['/a'], JSON.stringify(patch));
    }
  });

  it('mixed add / remove / change / unchanged', () => {
    const prev = map([['/keep', spec()], ['/change', spec()], ['/gone', spec()]]);
    const next = map([['/keep', spec()], ['/change', spec({ badge: '2', role: 'referenced', colorId: 'fileShake.referencedForeground' })], ['/new', spec()]]);
    assert.deepEqual(changedKeys(prev, next).sort(), ['/change', '/gone', '/new']);
  });

  it('does not return duplicates and does not mutate its arguments', () => {
    const prev = map([['/a', spec()]]);
    const next = map([['/a', spec({ badge: '◆' })], ['/b', spec()]]);
    const out = changedKeys(prev, next);
    assert.equal(new Set(out).size, out.length);
    assert.equal(prev.size, 1);
    assert.equal(next.size, 2);
  });
});
