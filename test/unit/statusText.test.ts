import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus } from '../../src/core/statusText';
import { viewRow } from '../support/builders';
import type { ViewRow } from '../support/types';

const edited = (name: string, o: Partial<ViewRow> = {}): ViewRow => viewRow(`/ws/${name}`, { name, ...o });
const referenced = (name: string): ViewRow => viewRow(`/ws/${name}`, { name, role: 'referenced', source: null, refCount: 2, badge: '×2 refs' });

describe('buildStatus', () => {
  it('disabled -> "$(circle-slash) File Shake: off"', () => {
    assert.equal(buildStatus({ enabled: false, rows: [] }).text, '$(circle-slash) File Shake: off');
    assert.equal(buildStatus({ enabled: false, rows: [edited('a.ts')] }).text, '$(circle-slash) File Shake: off', 'rows are ignored while disabled');
    assert.ok(buildStatus({ enabled: false, rows: [] }).tooltip.length > 0);
  });

  it('nothing active -> "$(pulse) File Shake"', () => {
    const s = buildStatus({ enabled: true, rows: [] });
    assert.equal(s.text, '$(pulse) File Shake');
    assert.ok(s.tooltip.length > 0);
  });

  it('one file being typed in -> name and "typing"', () => {
    assert.equal(buildStatus({ enabled: true, rows: [edited('index.ts')] }).text, '$(pulse) index.ts · typing');
  });

  it('external edits are labelled "external"', () => {
    assert.equal(buildStatus({ enabled: true, rows: [edited('x.py', { source: 'external' })] }).text, '$(pulse) x.py · external');
  });

  it('the DESIGN example: "$(pulse) index.ts · typing · 3 refs"', () => {
    const rows = [edited('index.ts'), referenced('a.ts'), referenced('b.ts'), referenced('c.ts')];
    assert.equal(buildStatus({ enabled: true, rows }).text, '$(pulse) index.ts · typing · 3 refs');
  });

  it('singular: "1 ref" (R counts referenced ROWS, not the summed reference counts)', () => {
    assert.equal(buildStatus({ enabled: true, rows: [edited('index.ts'), referenced('a.ts')] }).text, '$(pulse) index.ts · typing · 1 ref');
  });

  it('the primary file is the first edited row whose phase is active', () => {
    const rows = [edited('old.ts', { phase: 'idle', intensity: 0 }), edited('live.ts'), edited('other.ts')];
    assert.equal(buildStatus({ enabled: true, rows }).text, '$(pulse) live.ts · typing');
  });

  it('only idle edited rows -> falls back to the plain label or the first idle row, never throws', () => {
    const s = buildStatus({ enabled: true, rows: [edited('old.ts', { phase: 'idle', intensity: 0 })] });
    assert.ok(s.text === '$(pulse) File Shake' || s.text.startsWith('$(pulse) old.ts'), s.text);
  });

  it('tooltip: header with E edited / R referenced, then one line per edited row "name — badge"', () => {
    const rows = [edited('a.ts'), edited('b.ts', { source: 'external', badge: 'external' }), referenced('r1.ts'), referenced('r2.ts'), referenced('r3.ts')];
    const { tooltip } = buildStatus({ enabled: true, rows });
    const lines = tooltip.split('\n');
    assert.equal(lines[0], 'File Shake — 2 edited, 3 referenced');
    assert.deepEqual(lines.slice(1), ['a.ts — typing', 'b.ts — external']);
  });

  it('tooltip for referenced-only or empty state is still well-formed', () => {
    const { tooltip } = buildStatus({ enabled: true, rows: [] });
    assert.equal(tooltip.split('\n')[0], 'File Shake — 0 edited, 0 referenced');
  });

  it('hostile names appear verbatim as text (status bar text is rendered as plain text by VS Code)', () => {
    const s = buildStatus({ enabled: true, rows: [edited('<img onerror=x>.ts')] });
    assert.ok(s.text.includes('<img onerror=x>.ts'));
  });
});
