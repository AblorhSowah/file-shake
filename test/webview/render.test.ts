import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { actorEls, click, folderById, folderEls, mount, rowById, rowEls, text, treeOf } from '../support/dom';
import type { Harness } from '../support/dom';
import { snapshotOf, viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import type { ViewRow } from '../support/types';

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const refRow = (key: string, o: Partial<ViewRow> = {}): ViewRow =>
  viewRow(key, {
    role: 'referenced',
    source: null,
    refCount: 5,
    badge: '×5 refs',
    tooltip: 'Referenced 5× by a.ts',
    intensity: 0.5124,
    shake: { amp: 2.29, dur: 109, rot: 0.71 },
    ...o,
  });

describe('webview: mounting and the three states', () => {
  it('posts exactly one {type:"ready"} on mount and nothing else', () => {
    h = mount();
    assert.deepEqual(h.host.messages, [{ type: 'ready' }]);
  });

  it('starts in the empty state with a text-only hint and no tree', () => {
    h = mount();
    assert.equal(h.root.getAttribute('data-state'), 'empty');
    const empty = must(h.root.querySelector('.fs-empty'));
    assert.ok((empty.textContent ?? '').trim().length > 10);
    assert.equal(empty.children.length, 0, '.fs-empty is text only');
    assert.equal(h.root.querySelectorAll('li').length, 0, 'no rows or folders are rendered');
  });

  it('a snapshot with no rows stays "empty"; enabled=false is "disabled" with its own hint', () => {
    h = mount();
    h.sendRows([]);
    assert.equal(h.root.getAttribute('data-state'), 'empty');
    const emptyText = h.root.querySelector('.fs-empty')?.textContent ?? '';
    h.sendRows([], { enabled: false });
    assert.equal(h.root.getAttribute('data-state'), 'disabled');
    const disabledText = h.root.querySelector('.fs-empty')?.textContent ?? '';
    assert.ok(disabledText.trim().length > 10);
    assert.notEqual(disabledText, emptyText);
    assert.equal(h.root.querySelectorAll('li').length, 0, 'no rows or folders are rendered');
  });

  it('disabled hides rows even if the snapshot still carries some', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.equal(rowEls(h.root).length, 1);
    h.sendRows([viewRow('/ws/a.ts')], { enabled: false });
    assert.equal(h.root.getAttribute('data-state'), 'disabled');
  });

  it('rows switch the root to data-state="rows" with a role=tree list and no empty hint', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.equal(h.root.getAttribute('data-state'), 'rows');
    const tree = must(h.root.querySelector('ul.fs-tree'));
    assert.equal(tree.getAttribute('role'), 'tree');
    assert.equal(h.root.querySelector('.fs-empty'), null);
  });

  it('going back from rows to empty removes the tree (after the leave animation)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    h.sendRows([]);
    h.env.runTimers();
    assert.equal(rowEls(h.root).length, 0);
    assert.equal(h.root.getAttribute('data-state'), 'empty');
  });
});

describe('webview: DOM contract for rows', () => {
  it('an edited row has every documented class, attribute and child', () => {
    h = mount();
    h.sendRows([viewRow('/ws/src/a.ts', { dir: 'src', folderPath: ['src'], badge: 'typing', name: 'a.ts' })]);
    const el = must(rowById(h.root, '/ws/src/a.ts'));
    assert.equal(el.tagName, 'LI');
    assert.ok(el.classList.contains('fs-row'));
    assert.ok(el.classList.contains('fs-row--edited'));
    assert.ok(!el.classList.contains('fs-row--referenced'));
    assert.equal(el.getAttribute('data-id'), '/ws/src/a.ts');
    assert.equal(el.getAttribute('data-role'), 'edited');
    assert.equal(el.getAttribute('data-phase'), 'active');
    assert.equal(el.getAttribute('data-source'), 'you');
    assert.equal(el.getAttribute('role'), 'treeitem');
    assert.equal(el.getAttribute('tabindex'), '0');
    assert.ok((el.getAttribute('aria-label') ?? '').includes('a.ts'));
    assert.equal(text(el, 'span.fs-name'), 'a.ts');
    assert.equal(text(el, 'span.fs-dir'), 'src');
    assert.equal(text(el, 'span.fs-badge'), 'typing');
    const meter = must(el.querySelector('span.fs-meter'));
    assert.equal(meter.querySelectorAll(':scope > i').length, 1);
  });

  it('external edits carry data-source="external"', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { source: 'external', badge: 'external' })]);
    assert.equal(must(rowById(h.root, '/ws/a.ts')).getAttribute('data-source'), 'external');
    assert.equal(text(rowById(h.root, '/ws/a.ts'), 'span.fs-badge'), 'external');
  });

  it('a referenced row has the referenced class, role and badge; it has no you/external source', () => {
    h = mount();
    h.sendRows([refRow('/ws/lib/b.ts')]);
    const el = must(rowById(h.root, '/ws/lib/b.ts'));
    assert.ok(el.classList.contains('fs-row--referenced'));
    assert.ok(!el.classList.contains('fs-row--edited'));
    assert.equal(el.getAttribute('data-role'), 'referenced');
    assert.ok(!['you', 'external'].includes(el.getAttribute('data-source') ?? ''));
    assert.equal(text(el, 'span.fs-badge'), '×5 refs');
  });

  it('idle rows get .is-idle and data-phase="idle"; active rows do not', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { phase: 'idle', intensity: 0, shake: { amp: 0, dur: 160, rot: 0 } }), viewRow('/ws/b.ts')]);
    const a = must(rowById(h.root, '/ws/a.ts'));
    const b = must(rowById(h.root, '/ws/b.ts'));
    assert.ok(a.classList.contains('is-idle'));
    assert.equal(a.getAttribute('data-phase'), 'idle');
    assert.ok(!b.classList.contains('is-idle'));
    assert.equal(b.getAttribute('data-phase'), 'active');
  });

  it('tooltips are exposed as text (title or aria-label), never as markup', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { tooltip: 'Edited by you (typing) · 3 edits' })]);
    const el = must(rowById(h.root, '/ws/a.ts'));
    const exposed = `${el.getAttribute('title') ?? ''}|${el.getAttribute('aria-label') ?? ''}`;
    assert.ok(exposed.includes('3 edits') || exposed.includes('a.ts'), exposed);
  });

  it('root-level files sit directly in their user\'s section list', () => {
    h = mount();
    h.sendRows([viewRow('/ws/top.ts', { folderPath: [], dir: '' })]);
    assert.equal(must(rowById(h.root, '/ws/top.ts')).parentElement, must(treeOf(h.root, 'you')));
  });
});

describe('webview: CSS custom properties (set via style.setProperty only)', () => {
  it('exact strings for intensity 0.5: --fs-amp 2.25px, --fs-dur 110ms, --fs-rot 0.7deg, --fs-level 0.5', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.5, shake: { amp: 2.25, dur: 110, rot: 0.7 } })]);
    const s = must(rowById(h.root, '/ws/a.ts')).style;
    assert.equal(s.getPropertyValue('--fs-amp'), '2.25px');
    assert.equal(s.getPropertyValue('--fs-dur'), '110ms');
    assert.equal(s.getPropertyValue('--fs-rot'), '0.7deg');
    assert.equal(s.getPropertyValue('--fs-level'), '0.5');
  });

  it('the referenced example: 2.29px / 109ms / 0.71deg / level 0.512', () => {
    h = mount();
    h.sendRows([refRow('/ws/b.ts')]);
    const s = must(rowById(h.root, '/ws/b.ts')).style;
    assert.equal(s.getPropertyValue('--fs-amp'), '2.29px');
    assert.equal(s.getPropertyValue('--fs-dur'), '109ms');
    assert.equal(s.getPropertyValue('--fs-rot'), '0.71deg');
    assert.equal(s.getPropertyValue('--fs-level'), '0.512', '--fs-level is rounded to 3 decimals');
  });

  it('extremes: zero shake and full intensity', () => {
    h = mount();
    h.sendRows([
      viewRow('/ws/zero.ts', { intensity: 0, phase: 'idle', shake: { amp: 0, dur: 160, rot: 0 } }),
      viewRow('/ws/full.ts', { intensity: 1, shake: { amp: 4, dur: 60, rot: 1.2 } }),
    ]);
    const z = must(rowById(h.root, '/ws/zero.ts')).style;
    assert.equal(z.getPropertyValue('--fs-amp'), '0px');
    assert.equal(z.getPropertyValue('--fs-dur'), '160ms');
    assert.equal(z.getPropertyValue('--fs-rot'), '0deg');
    assert.equal(z.getPropertyValue('--fs-level'), '0');
    const f = must(rowById(h.root, '/ws/full.ts')).style;
    assert.equal(f.getPropertyValue('--fs-amp'), '4px');
    assert.equal(f.getPropertyValue('--fs-dur'), '60ms');
    assert.equal(f.getPropertyValue('--fs-rot'), '1.2deg');
    assert.equal(f.getPropertyValue('--fs-level'), '1');
  });

  it('--fs-level is rounded to three decimals', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.123456 })]);
    assert.equal(must(rowById(h.root, '/ws/a.ts')).style.getPropertyValue('--fs-level'), '0.123');
  });

  it('values update in place when a later snapshot changes the intensity', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.2, shake: { amp: 1.2, dur: 140, rot: 0.4 } })]);
    h.sendRows([viewRow('/ws/a.ts', { intensity: 1, shake: { amp: 4, dur: 60, rot: 1.2 } })]);
    const s = must(rowById(h.root, '/ws/a.ts')).style;
    assert.equal(s.getPropertyValue('--fs-amp'), '4px');
    assert.equal(s.getPropertyValue('--fs-level'), '1');
  });

  it('inline styles in the document consist only of --fs-* custom properties (nothing else is ever styled inline)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a/b.ts'), refRow('/ws/c.ts')], { colors: { edited: '#112233', referenced: '#aabbcc' } });
    const styled = [...h.root.querySelectorAll('[style]'), ...(h.root.hasAttribute('style') ? [h.root] : [])];
    assert.ok(styled.length > 0);
    for (const el of styled) {
      const decl = (el.getAttribute('style') ?? '').split(';').map((d) => d.trim()).filter(Boolean);
      for (const d of decl) assert.match(d, /^--fs-[a-z-]+\s*:/, `unexpected inline declaration ${JSON.stringify(d)} on <${el.tagName.toLowerCase()} class="${el.className}">`);
    }
  });
});

describe('webview: colour overrides (root custom properties)', () => {
  it('a non-empty colour sets the override on the root; empty removes it', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')], { colors: { edited: '#ff0000', referenced: '#00ff00' } });
    assert.equal(h.root.style.getPropertyValue('--fs-edited-override'), '#ff0000');
    assert.equal(h.root.style.getPropertyValue('--fs-referenced-override'), '#00ff00');
    h.sendRows([viewRow('/ws/a.ts')], { colors: { edited: '', referenced: '#00ff00' } });
    assert.equal(h.root.style.getPropertyValue('--fs-edited-override'), '');
    assert.equal(h.root.style.getPropertyValue('--fs-referenced-override'), '#00ff00');
    h.sendRows([viewRow('/ws/a.ts')], { colors: { edited: '', referenced: '' } });
    assert.equal(h.root.style.getPropertyValue('--fs-referenced-override'), '');
  });

  it('with the default empty colours the overrides were never set', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.equal(h.root.style.getPropertyValue('--fs-edited-override'), '');
    assert.equal(h.root.style.getPropertyValue('--fs-referenced-override'), '');
  });
});

describe('webview: folders and tree layout', () => {
  it('folders are li.fs-folder with the documented structure and start expanded', () => {
    h = mount();
    h.sendRows([viewRow('/ws/src/a.ts'), viewRow('/ws/src/b.ts')]);
    const f = must(folderById(h.root, 'src'));
    assert.equal(f.getAttribute('role'), 'treeitem');
    assert.equal(f.getAttribute('aria-expanded'), 'true');
    const toggle = must(f.querySelector(':scope > button.fs-folder-toggle'));
    assert.ok(toggle.querySelector('span.fs-chevron'));
    assert.equal(text(toggle, 'span.fs-folder-label'), 'src');
    assert.ok(toggle.querySelector('span.fs-folder-count'));
    const children = must(f.querySelector(':scope > ul.fs-children'));
    assert.equal(children.getAttribute('role'), 'group');
    assert.equal(children.querySelectorAll(':scope > li.fs-row').length, 2);
  });

  it('a folder chain with no siblings is compacted into a single "a/b" folder with the full id', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a/b/x.ts', { folderPath: ['a', 'b'], dir: 'a/b' })]);
    assert.equal(folderEls(h.root).length, 1);
    const f = must(folderById(h.root, 'a/b'));
    assert.equal(text(f, ':scope > button span.fs-folder-label'), 'a/b');
  });

  it('nested folders nest in the DOM', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a/p/1.ts', { folderPath: ['a', 'p'], dir: 'a/p' }), viewRow('/ws/a/q/2.ts', { folderPath: ['a', 'q'], dir: 'a/q' })]);
    const a = must(folderById(h.root, 'a'));
    const p = must(folderById(h.root, 'a/p'));
    const q = must(folderById(h.root, 'a/q'));
    assert.ok(a.contains(p) && a.contains(q));
    assert.notEqual(p, q);
  });

  it('the folder count shows the number of descendant files', () => {
    h = mount();
    h.sendRows([viewRow('/ws/s/a.ts'), viewRow('/ws/s/b.ts'), viewRow('/ws/s/c.ts')].map((r) => ({ ...r, folderPath: ['s'], dir: 's' })));
    assert.match(text(folderById(h.root, 's'), ':scope > button span.fs-folder-count'), /\b3\b/);
  });

  it('siblings are alphabetical, folders before files, and do not reorder when intensities change', () => {
    h = mount();
    const rows = (hi: string): ViewRow[] => [
      viewRow('/ws/b.ts', { folderPath: [], dir: '', intensity: hi === 'b' ? 0.9 : 0.1 }),
      viewRow('/ws/a.ts', { folderPath: [], dir: '', intensity: hi === 'a' ? 0.9 : 0.1 }),
      viewRow('/ws/zdir/x.ts', { folderPath: ['zdir'], dir: 'zdir' }),
    ];
    h.sendRows(rows('a'));
    const order = (): string[] => [...must(h && treeOf(h.root, 'you')).children].map((c) => c.getAttribute('data-folder-id') ?? c.getAttribute('data-id') ?? '?');
    assert.deepEqual(order(), ['@you/zdir', '/ws/a.ts', '/ws/b.ts']);
    const nodeA = rowById(h.root, '/ws/a.ts');
    h.sendRows(rows('b'));
    assert.deepEqual(order(), ['@you/zdir', '/ws/a.ts', '/ws/b.ts']);
    assert.equal(rowById(h.root, '/ws/a.ts'), nodeA, 'the same DOM node is reused');
  });

  it('same file name in two workspace roots renders two distinct rows', () => {
    h = mount();
    h.sendRows([
      viewRow('/w/a/x.ts', { folderPath: ['alpha'], dir: 'alpha' }),
      viewRow('/w/b/x.ts', { folderPath: ['beta'], dir: 'beta' }),
    ]);
    assert.equal(rowEls(h.root).length, 2);
    assert.ok(rowById(h.root, '/w/a/x.ts'));
    assert.ok(rowById(h.root, '/w/b/x.ts'));
  });

  it('files outside the workspace render under the "(outside workspace)" folder', () => {
    h = mount();
    h.sendRows([viewRow('/tmp/loose/a.ts', { folderPath: ['(outside workspace)', 'tmp', 'loose'], dir: '/tmp/loose' })]);
    assert.ok(folderById(h.root, '(outside workspace)/tmp/loose'));
  });

  it('a row that moves to another folder (same id) exists exactly once, under the new folder', () => {
    h = mount();
    h.sendRows([viewRow('/ws/x.ts', { folderPath: ['one'], dir: 'one' })]);
    h.sendRows([viewRow('/ws/x.ts', { folderPath: ['two'], dir: 'two' })]);
    h.env.runTimers();
    const matches = rowEls(h.root).filter((e) => e.getAttribute('data-id') === '/ws/x.ts');
    assert.equal(matches.length, 1);
    assert.ok(must(folderById(h.root, 'two')).contains(must(matches[0])));
  });
});

describe('webview: updates keep DOM nodes (no full re-render)', () => {
  it('row and folder nodes persist across snapshots so CSS animations do not restart', () => {
    h = mount();
    h.sendRows([viewRow('/ws/s/a.ts'), viewRow('/ws/s/b.ts')].map((r) => ({ ...r, folderPath: ['s'], dir: 's' })));
    const row = must(rowById(h.root, '/ws/s/a.ts'));
    const folder = must(folderById(h.root, 's'));
    const tree = must(h.root.querySelector('ul.fs-tree'));
    h.sendRows(
      [viewRow('/ws/s/a.ts', { intensity: 0.9, tooltip: 'x', badge: 'external', source: 'external' }), viewRow('/ws/s/b.ts')].map((r) => ({ ...r, folderPath: ['s'], dir: 's' })),
    );
    assert.equal(rowById(h.root, '/ws/s/a.ts'), row);
    assert.equal(folderById(h.root, 's'), folder);
    assert.equal(h.root.querySelector('ul.fs-tree'), tree);
    assert.equal(row.getAttribute('data-source'), 'external');
    assert.equal(text(row, 'span.fs-badge'), 'external');
  });

  it('a row\'s role can change in place (referenced -> edited) with updated classes', () => {
    h = mount();
    h.sendRows([refRow('/ws/b.ts')]);
    h.sendRows([viewRow('/ws/b.ts')]);
    const el = must(rowById(h.root, '/ws/b.ts'));
    assert.ok(el.classList.contains('fs-row--edited'));
    assert.ok(!el.classList.contains('fs-row--referenced'));
    assert.equal(el.getAttribute('data-role'), 'edited');
    assert.equal(rowEls(h.root).length, 1);
  });

  it('50 successive snapshots with 100 rows each leave exactly 100 rows (no leaks)', () => {
    h = mount();
    for (let i = 0; i < 50; i++) {
      h.sendRows(Array.from({ length: 100 }, (_, n) => viewRow(`/ws/d${n % 7}/f${n}.ts`, { folderPath: [`d${n % 7}`], dir: `d${n % 7}`, intensity: ((n + i) % 10) / 10 })));
    }
    assert.equal(rowEls(h.root).length, 100);
    assert.equal(folderEls(h.root).length, 7);
  });

  it('500 rows render', () => {
    h = mount();
    const rows = Array.from({ length: 500 }, (_, n) => viewRow(`/ws/d${n % 25}/f${n}.ts`, { folderPath: [`d${n % 25}`], dir: `d${n % 25}` }));
    const t0 = performance.now();
    h.sendRows(rows);
    const ms = performance.now() - t0;
    assert.equal(rowEls(h.root).length, 500);
    assert.ok(ms < 3000, `render took ${ms.toFixed(0)} ms`);
  });
});

describe('webview: snapshot sequencing', () => {
  it('lastSeq follows accepted snapshots; an older seq is ignored entirely', () => {
    h = mount();
    h.send(snapshotOf([viewRow('/ws/new.ts')], { seq: 5 }));
    assert.equal(h.app.lastSeq, 5);
    h.send(snapshotOf([viewRow('/ws/old.ts')], { seq: 3 }));
    assert.equal(h.app.lastSeq, 5);
    assert.ok(rowById(h.root, '/ws/new.ts'));
    assert.equal(rowById(h.root, '/ws/old.ts'), undefined);
  });

  it('an equal seq is accepted (only seq < lastSeq is dropped); a newer seq replaces', () => {
    h = mount();
    h.send(snapshotOf([viewRow('/ws/a.ts', { badge: 'typing' })], { seq: 5 }));
    h.send(snapshotOf([viewRow('/ws/a.ts', { badge: 'external', source: 'external' })], { seq: 5 }));
    assert.equal(text(rowById(h.root, '/ws/a.ts'), 'span.fs-badge'), 'external');
    h.send(snapshotOf([viewRow('/ws/a.ts', { badge: 'typing' })], { seq: 6 }));
    assert.equal(h.app.lastSeq, 6);
    assert.equal(text(rowById(h.root, '/ws/a.ts'), 'span.fs-badge'), 'typing');
  });

  it('an out-of-order snapshot cannot resurrect old state or clear a newer disabled state', () => {
    h = mount();
    h.send(snapshotOf([], { seq: 10, enabled: false }));
    h.send(snapshotOf([viewRow('/ws/a.ts')], { seq: 4, enabled: true }));
    assert.equal(h.root.getAttribute('data-state'), 'disabled');
  });
});

describe('webview: the two users (You and External)', () => {
  it('rows are grouped into a "You" section and an "External" section, You first, each with its own count', () => {
    h = mount();
    h.sendRows([
      viewRow('/ws/ext.ts', { source: 'external', badge: 'external', folderPath: [], dir: '' }),
      viewRow('/ws/mine.ts', { folderPath: [], dir: '' }),
      viewRow('/ws/mine2.ts', { folderPath: [], dir: '' }),
    ]);
    const sections = actorEls(h.root);
    assert.deepEqual(sections.map((el) => el.getAttribute('data-actor')), ['you', 'external']);
    assert.deepEqual(sections.map((el) => el.getAttribute('data-folder-id')), ['@you', '@external']);
    assert.match(text(sections[0], ':scope > button span.fs-folder-label'), /^You/);
    assert.match(text(sections[1], ':scope > button span.fs-folder-label'), /^External/);
    assert.match(text(sections[0], ':scope > button span.fs-folder-count'), /\b2\b/);
    assert.match(text(sections[1], ':scope > button span.fs-folder-count'), /\b1\b/);
    assert.equal(must(rowById(h.root, '/ws/mine.ts')).parentElement, treeOf(h.root, 'you'));
    assert.equal(must(rowById(h.root, '/ws/ext.ts')).parentElement, treeOf(h.root, 'external'));
  });

  it('a section exists only while its user has rows, and the empty-state text is not shown with rows', () => {
    h = mount();
    h.sendRows([viewRow('/ws/mine.ts', { folderPath: [], dir: '' })]);
    assert.deepEqual(actorEls(h.root).map((el) => el.getAttribute('data-actor')), ['you']);
    assert.equal(h.root.querySelector('.fs-empty'), null);
  });

  it('the same folder name under both users gives two distinct folders (ids are namespaced per user)', () => {
    h = mount();
    h.sendRows([
      viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' }),
      viewRow('/ws/src/b.ts', { folderPath: ['src'], dir: 'src', source: 'external', badge: 'external' }),
    ]);
    const ids = folderEls(h.root).map((el) => el.getAttribute('data-folder-id')).sort();
    assert.deepEqual(ids, ['@external/src', '@you/src']);
    assert.equal(rowEls(h.root).length, 2);
  });

  it('a file that changes user moves to the other section and the emptied section disappears', () => {
    h = mount();
    h.sendRows([viewRow('/ws/x.ts', { folderPath: [], dir: '' })]);
    assert.deepEqual(actorEls(h.root).map((el) => el.getAttribute('data-actor')), ['you']);
    h.sendRows([viewRow('/ws/x.ts', { folderPath: [], dir: '', source: 'external', badge: 'external' })]);
    assert.deepEqual(actorEls(h.root).map((el) => el.getAttribute('data-actor')), ['external']);
    assert.equal(rowEls(h.root).length, 1);
  });

  it('a yellow row is listed under the user given by its actor, not by its (null) source', () => {
    h = mount();
    h.sendRows([
      viewRow('/ws/ext.ts', { source: 'external', badge: 'external', folderPath: [], dir: '' }),
      viewRow('/ws/dep.ts', { role: 'referenced', source: null, actor: 'external', badge: '×2 refs', refCount: 2, folderPath: [], dir: '' }),
    ]);
    assert.equal(must(rowById(h.root, '/ws/dep.ts')).parentElement, treeOf(h.root, 'external'));
  });

  it('a user section can be collapsed like a folder and the choice is persisted', () => {
    h = mount();
    h.sendRows([viewRow('/ws/mine.ts', { folderPath: [], dir: '' })]);
    const section = must(actorEls(h.root)[0]);
    click(must(section.querySelector(':scope > button.fs-folder-toggle')));
    assert.equal(section.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(h.host.lastCollapsed, ['@you']);
  });
});
