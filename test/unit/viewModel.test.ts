import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows } from '../../src/core/viewModel';
import type { ModelInput } from '../../src/core/viewModel';
import { referenceIntensity, shakeParams } from '../../src/core/intensity';
import { K } from '../../src/core/constants';
import { refResult, trackedFile } from '../support/builders';
import { must } from '../support/fixtures';
import type { FileKey, ReferenceResult, TrackedFile, ViewRow, WorkspaceRoot } from '../support/types';

const ROOTS: WorkspaceRoot[] = [{ key: '/ws', name: 'ws' }];

function input(
  tracked: TrackedFile[],
  refs: ReferenceResult[] = [],
  o: Partial<ModelInput> = {},
): ModelInput {
  return {
    tracked,
    references: new Map<FileKey, ReferenceResult>(refs.map((r) => [r.source, r])),
    roots: ROOTS,
    toUri: (k: FileKey) => `file://${k}`,
    sensitivity: 1,
    maxFiles: 40,
    showWhenIdle: false,
    ...o,
  };
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const byId = (rows: ViewRow[], id: string): ViewRow => must(rows.find((r) => r.id === id), id);

describe('buildRows: edited rows', () => {
  it('maps a tracked file to an edited row with every field', () => {
    const t = trackedFile('/ws/src/a.ts', { intensity: 0.5, editCount: 3, source: 'you' });
    const [row, ...rest] = buildRows(input([t]));
    assert.equal(rest.length, 0);
    assert.ok(row);
    assert.equal(row.id, '/ws/src/a.ts');
    assert.equal(row.uri, 'file:///ws/src/a.ts');
    assert.equal(row.name, 'a.ts');
    assert.equal(row.dir, 'src');
    assert.deepEqual(row.folderPath, ['src']);
    assert.equal(row.role, 'edited');
    assert.equal(row.source, 'you');
    assert.equal(row.phase, 'active');
    assert.equal(row.intensity, 0.5);
    assert.deepEqual(row.shake, shakeParams(0.5));
    assert.deepEqual(row.shake, { amp: 2.25, dur: 110, rot: 0.7 });
    assert.equal(row.refCount, 0);
    assert.equal(row.badge, 'typing');
    assert.equal(row.tooltip, 'Edited by you (typing) · 3 edits');
  });

  it('external edits get the external badge and tooltip', () => {
    const [row] = buildRows(input([trackedFile('/ws/a.ts', { source: 'external', editCount: 2 })]));
    assert.equal(must(row).badge, 'external');
    assert.equal(must(row).tooltip, 'Changed outside the editor (external) · 2 edits');
    assert.equal(must(row).source, 'external');
  });

  it('a single edit still produces a sensible tooltip', () => {
    const [row] = buildRows(input([trackedFile('/ws/a.ts', { editCount: 1 })]));
    assert.match(must(row).tooltip, /^Edited by you \(typing\) · 1 edits?$/);
  });

  it('idle edited rows keep their role but have zero intensity and zero shake', () => {
    const [row] = buildRows(input([trackedFile('/ws/a.ts', { phase: 'idle', intensity: 0 })], [], { showWhenIdle: true }));
    assert.equal(must(row).phase, 'idle');
    assert.equal(must(row).intensity, 0);
    assert.deepEqual(must(row).shake, { amp: 0, dur: 160, rot: 0 });
  });

  it('keeps the tracker order (lastEditAt desc)', () => {
    const rows = buildRows(
      input([
        trackedFile('/ws/z.ts', { lastEditAt: 3000 }),
        trackedFile('/ws/a.ts', { lastEditAt: 2000 }),
        trackedFile('/ws/m.ts', { lastEditAt: 1000 }),
      ]),
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/z.ts', '/ws/a.ts', '/ws/m.ts'],
    );
  });

  it('multi-root: same file name in two roots stays distinct (id = full key) and folderPath starts with the root name', () => {
    const roots: WorkspaceRoot[] = [
      { key: '/w/a', name: 'alpha' },
      { key: '/w/b', name: 'beta' },
    ];
    const rows = buildRows(input([trackedFile('/w/a/x.ts'), trackedFile('/w/b/x.ts', { lastEditAt: 999 })], [], { roots }));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id).sort(), ['/w/a/x.ts', '/w/b/x.ts']);
    assert.deepEqual(byId(rows, '/w/a/x.ts').folderPath, ['alpha']);
    assert.deepEqual(byId(rows, '/w/b/x.ts').folderPath, ['beta']);
    assert.equal(byId(rows, '/w/a/x.ts').dir, 'alpha');
  });

  it('no folder open: rows are grouped under "(outside workspace)"', () => {
    const [row] = buildRows(input([trackedFile('/tmp/loose/a.ts')], [], { roots: [] }));
    assert.deepEqual(must(row).folderPath, ['(outside workspace)', 'tmp', 'loose']);
    assert.equal(must(row).dir, '/tmp/loose');
  });

  it('empty input -> no rows', () => {
    assert.deepEqual(buildRows(input([])), []);
  });

  it('does not mutate its input (deep-frozen input does not throw)', () => {
    const i = input([trackedFile('/ws/a.ts'), trackedFile('/ws/b.ts')], [refResult('/ws/a.ts', [{ key: '/ws/c.ts', count: 2 }])]);
    deepFreeze(i.tracked);
    deepFreeze(i.roots);
    for (const r of i.references.values()) deepFreeze(r);
    assert.doesNotThrow(() => buildRows(i));
  });
});

describe('buildRows: referenced rows', () => {
  const a = trackedFile('/ws/a.ts', { lastEditAt: 5000 });

  it('a target of the active source becomes a referenced row (green source, yellow target)', () => {
    const rows = buildRows(input([a], [refResult('/ws/a.ts', [{ key: '/ws/lib/b.ts', count: 5 }])]));
    assert.equal(rows.length, 2);
    const b = byId(rows, '/ws/lib/b.ts');
    assert.equal(b.role, 'referenced');
    assert.equal(b.source, null);
    assert.equal(b.phase, 'active');
    assert.equal(b.refCount, 5);
    assert.ok(Math.abs(b.intensity - referenceIntensity(5, 1)) < 1e-12);
    assert.deepEqual(b.shake, { amp: 2.29, dur: 109, rot: 0.71 });
    assert.equal(b.badge, '×5 refs');
    assert.equal(b.tooltip, 'Referenced 5× by a.ts');
    assert.equal(b.name, 'b.ts');
    assert.deepEqual(b.folderPath, ['lib']);
    assert.equal(byId(rows, '/ws/a.ts').role, 'edited');
  });

  it('singular badge for one reference: "×1 ref"', () => {
    const rows = buildRows(input([a], [refResult('/ws/a.ts', [{ key: '/ws/b.ts', count: 1 }])]));
    assert.equal(byId(rows, '/ws/b.ts').badge, '×1 ref');
    assert.equal(byId(rows, '/ws/b.ts').tooltip, 'Referenced 1× by a.ts');
  });

  it('green wins: a target that is itself tracked yields ONE row, role edited', () => {
    const b = trackedFile('/ws/b.ts', { lastEditAt: 4000 });
    const rows = buildRows(input([a, b], [refResult('/ws/a.ts', [{ key: '/ws/b.ts', count: 9 }])]));
    assert.equal(rows.filter((r) => r.id === '/ws/b.ts').length, 1);
    assert.equal(byId(rows, '/ws/b.ts').role, 'edited');
    assert.equal(byId(rows, '/ws/b.ts').refCount, 0);
    assert.equal(rows.length, 2);
  });

  it('a file never references itself', () => {
    const rows = buildRows(input([a], [refResult('/ws/a.ts', [{ key: '/ws/a.ts', count: 3 }])]));
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/a.ts'],
    );
  });

  it('a source without a reference result (analysis pending or skipped) contributes nothing', () => {
    const rows = buildRows(input([a, trackedFile('/ws/c.ts', { lastEditAt: 4000 })], [refResult('/ws/c.ts', [{ key: '/ws/x.ts', count: 1 }])]));
    assert.deepEqual(rows.map((r) => r.id).sort(), ['/ws/a.ts', '/ws/c.ts', '/ws/x.ts']);
    assert.doesNotThrow(() => buildRows(input([a])));
  });

  it('references from several sources are summed and the tooltip lists the source names in order', () => {
    const b = trackedFile('/ws/other/b.ts', { lastEditAt: 4000 });
    const rows = buildRows(
      input(
        [a, b],
        [refResult('/ws/a.ts', [{ key: '/ws/shared.ts', count: 2 }]), refResult('/ws/other/b.ts', [{ key: '/ws/shared.ts', count: 3 }])],
      ),
    );
    const shared = byId(rows, '/ws/shared.ts');
    assert.equal(shared.refCount, 5);
    assert.equal(shared.badge, '×5 refs');
    assert.equal(shared.tooltip, 'Referenced 5× by a.ts, b.ts');
    assert.equal(rows.filter((r) => r.id === '/ws/shared.ts').length, 1);
  });

  it('only the first MAX_REFERENCE_SOURCES active tracked files act as sources (idle ones are skipped)', () => {
    assert.equal(K.MAX_REFERENCE_SOURCES, 3);
    const t = [
      trackedFile('/ws/idle.ts', { phase: 'idle', intensity: 0, lastEditAt: 9000 }),
      trackedFile('/ws/s1.ts', { lastEditAt: 8000 }),
      trackedFile('/ws/s2.ts', { lastEditAt: 7000 }),
      trackedFile('/ws/s3.ts', { lastEditAt: 6000 }),
      trackedFile('/ws/s4.ts', { lastEditAt: 5000 }),
    ];
    const refs = t.map((x) => refResult(x.key, [{ key: `/ws/t-${x.key.split('/').pop()}`, count: 1 }]));
    const rows = buildRows(input(t, refs));
    const referenced = rows.filter((r) => r.role === 'referenced').map((r) => r.id);
    assert.deepEqual(referenced.sort(), ['/ws/t-s1.ts', '/ws/t-s2.ts', '/ws/t-s3.ts']);
    assert.equal(rows.filter((r) => r.role === 'edited').length, 5, 'all tracked files still get edited rows');
  });

  it('showWhenIdle: idle files act as sources; their references are idle with zero intensity', () => {
    const idle = trackedFile('/ws/a.ts', { phase: 'idle', intensity: 0 });
    const rows = buildRows(input([idle], [refResult('/ws/a.ts', [{ key: '/ws/b.ts', count: 5 }])], { showWhenIdle: true }));
    const b = byId(rows, '/ws/b.ts');
    assert.equal(b.phase, 'idle');
    assert.equal(b.intensity, 0);
    assert.deepEqual(b.shake, { amp: 0, dur: 160, rot: 0 });
    assert.equal(b.refCount, 5);
  });

  it('without showWhenIdle an idle source contributes no referenced rows', () => {
    const idle = trackedFile('/ws/a.ts', { phase: 'idle', intensity: 0 });
    const rows = buildRows(input([idle], [refResult('/ws/a.ts', [{ key: '/ws/b.ts', count: 5 }])]));
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/a.ts'],
    );
  });

  it('a referenced row is active if ANY contributing source is active', () => {
    const idle = trackedFile('/ws/idle.ts', { phase: 'idle', intensity: 0, lastEditAt: 3000 });
    const live = trackedFile('/ws/live.ts', { lastEditAt: 2000 });
    const rows = buildRows(
      input(
        [idle, live],
        [refResult('/ws/idle.ts', [{ key: '/ws/t.ts', count: 1 }]), refResult('/ws/live.ts', [{ key: '/ws/t.ts', count: 1 }])],
        { showWhenIdle: true },
      ),
    );
    const t = byId(rows, '/ws/t.ts');
    assert.equal(t.phase, 'active');
    assert.ok(t.intensity > 0);
  });

  it('sensitivity feeds referenceIntensity', () => {
    const refs = [refResult('/ws/a.ts', [{ key: '/ws/b.ts', count: 3 }])];
    const lo = byId(buildRows(input([a], refs, { sensitivity: 0.25 })), '/ws/b.ts').intensity;
    const hi = byId(buildRows(input([a], refs, { sensitivity: 4 })), '/ws/b.ts').intensity;
    assert.ok(lo < hi);
    assert.ok(Math.abs(byId(buildRows(input([a], refs, { sensitivity: 2 })), '/ws/b.ts').intensity - referenceIntensity(3, 2)) < 1e-12);
  });

  it('referenced rows are ordered by refCount desc, then key asc, after all edited rows', () => {
    const refs = [
      refResult('/ws/a.ts', [
        { key: '/ws/z.ts', count: 2 },
        { key: '/ws/b.ts', count: 2 },
        { key: '/ws/m.ts', count: 7 },
        { key: '/ws/c.ts', count: 1 },
      ]),
    ];
    const rows = buildRows(input([a], refs));
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/a.ts', '/ws/m.ts', '/ws/b.ts', '/ws/z.ts', '/ws/c.ts'],
    );
  });
});

describe('buildRows: maxFiles trimming', () => {
  it('edited rows come first and are capped at maxFiles by recency', () => {
    const t = ['/ws/e1.ts', '/ws/e2.ts', '/ws/e3.ts', '/ws/e4.ts', '/ws/e5.ts'].map((k, i) => trackedFile(k, { lastEditAt: 9000 - i }));
    const rows = buildRows(input(t, [], { maxFiles: 3 }));
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/e1.ts', '/ws/e2.ts', '/ws/e3.ts'],
    );
  });

  it('referenced rows fill the remaining slots by refCount desc, key asc', () => {
    const refs = [
      refResult('/ws/e1.ts', [
        { key: '/ws/r-low.ts', count: 1 },
        { key: '/ws/r-high.ts', count: 9 },
        { key: '/ws/r-mid-b.ts', count: 4 },
        { key: '/ws/r-mid-a.ts', count: 4 },
      ]),
    ];
    const t = [trackedFile('/ws/e1.ts', { lastEditAt: 2 }), trackedFile('/ws/e2.ts', { lastEditAt: 1 })];
    const rows = buildRows(input(t, refs, { maxFiles: 4 }));
    assert.deepEqual(
      rows.map((r) => r.id),
      ['/ws/e1.ts', '/ws/e2.ts', '/ws/r-high.ts', '/ws/r-mid-a.ts'],
    );
  });

  it('never exceeds maxFiles overall', () => {
    const refs = [refResult('/ws/e1.ts', Array.from({ length: 30 }, (_, i) => ({ key: `/ws/r${i}.ts`, count: i + 1 })))];
    const t = Array.from({ length: 6 }, (_, i) => trackedFile(`/ws/e${i + 1}.ts`, { lastEditAt: 100 - i }));
    const rows = buildRows(input(t, refs, { maxFiles: 10 }));
    assert.equal(rows.length, 10);
  });
});
