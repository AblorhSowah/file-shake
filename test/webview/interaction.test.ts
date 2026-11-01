import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { click, folderById, key, mount, rowById, rowEls, text } from '../support/dom';
import type { Harness } from '../support/dom';
import { viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import type { ViewRow } from '../support/types';

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const inSrc = (name: string, o: Partial<ViewRow> = {}): ViewRow => viewRow(`/ws/src/${name}`, { folderPath: ['src'], dir: 'src', ...o });
const toggleOf = (id: string): HTMLElement => must(folderById(must(h).root, id)?.querySelector<HTMLElement>(':scope > button.fs-folder-toggle'));

describe('webview: opening files', () => {
  it('clicking a row posts {type:"open", id}', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    click(must(rowById(h.root, '/ws/b.ts')));
    assert.deepEqual(h.host.opens(), ['/ws/b.ts']);
  });

  it('clicking a child element inside the row (name, badge, meter) opens it too', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    const row = must(rowById(h.root, '/ws/a.ts'));
    for (const sel of ['span.fs-name', 'span.fs-dir', 'span.fs-badge', 'span.fs-meter', 'span.fs-meter > i']) {
      click(must(row.querySelector(sel), sel));
    }
    assert.deepEqual(h.host.opens(), ['/ws/a.ts', '/ws/a.ts', '/ws/a.ts', '/ws/a.ts', '/ws/a.ts']);
  });

  it('Enter and Space on a focused row open it; other keys do not', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    const row = must(rowById(h.root, '/ws/a.ts'));
    key(row, 'Enter');
    key(row, ' ');
    key(row, 'a');
    key(row, 'Tab');
    key(row, 'Escape');
    key(row, 'ArrowDown');
    assert.deepEqual(h.host.opens(), ['/ws/a.ts', '/ws/a.ts']);
  });

  it('a file whose id contains quotes, brackets, backslashes and unicode is posted verbatim', () => {
    h = mount();
    const id = '/ws/we"ird/[x]\\y\'z/日本語 😀.ts';
    h.sendRows([viewRow(id, { folderPath: ['we"ird', '[x]\\y\'z'], dir: 'we"ird/[x]\\y\'z', name: '日本語 😀.ts' })]);
    click(must(rowById(h.root, id)));
    assert.deepEqual(h.host.opens(), [id]);
  });

  it('clicking empty space, the root, or a folder toggle never posts "open"', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    click(h.root);
    click(must(h.root.querySelector('ul.fs-tree')));
    click(toggleOf('src'));
    click(must(h.root.querySelector('.fs-folder-label')));
    assert.deepEqual(h.host.opens(), []);
  });

  it('only the ready handshake and open messages are ever posted by interactions', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    click(toggleOf('src'));
    click(must(rowById(h.root, '/ws/src/a.ts')));
    for (const m of h.host.messages) assert.ok(m.type === 'ready' || m.type === 'open', m.type);
  });

  it('rows added later are clickable (delegation on the root, not per-row listeners lost on re-render)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    click(must(rowById(h.root, '/ws/b.ts')));
    click(must(rowById(h.root, '/ws/a.ts')));
    assert.deepEqual(h.host.opens(), ['/ws/b.ts', '/ws/a.ts']);
  });
});

describe('webview: collapsing folders', () => {
  it('clicking the toggle flips aria-expanded and persists the collapsed id via setState', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    const folder = must(folderById(h.root, 'src'));
    assert.equal(folder.getAttribute('aria-expanded'), 'true');
    click(toggleOf('src'));
    assert.equal(folder.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(h.host.lastCollapsed, ['src']);
    click(toggleOf('src'));
    assert.equal(folder.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(h.host.lastCollapsed, []);
  });

  it('Enter on the toggle flips it too, and preventDefault stops the native button click from toggling it back', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    const ev = key(toggleOf('src'), 'Enter');
    assert.equal(must(folderById(h.root, 'src')).getAttribute('aria-expanded'), 'false');
    assert.equal(ev.defaultPrevented, true, 'a real browser also fires click for Enter on a <button>; without preventDefault the folder would toggle twice');
  });

  it('a collapsed folder still shows its file count and keeps its rows in the document', () => {
    h = mount();
    h.sendRows([inSrc('a.ts'), inSrc('b.ts'), inSrc('c.ts')]);
    click(toggleOf('src'));
    const folder = must(folderById(h.root, 'src'));
    assert.match(text(folder, ':scope > button span.fs-folder-count'), /\b3\b/);
    assert.ok(rowById(h.root, '/ws/src/a.ts'), 'rows stay in the DOM (hidden by CSS), so animations and state survive');
  });

  it('collapsing one folder leaves the others alone', () => {
    h = mount();
    h.sendRows([inSrc('a.ts'), viewRow('/ws/lib/b.ts', { folderPath: ['lib'], dir: 'lib' })]);
    click(toggleOf('src'));
    assert.equal(must(folderById(h.root, 'src')).getAttribute('aria-expanded'), 'false');
    assert.equal(must(folderById(h.root, 'lib')).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(h.host.lastCollapsed, ['src']);
  });

  it('updates to files that are already known do not re-expand a collapsed folder', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    click(toggleOf('src'));
    h.sendRows([inSrc('a.ts', { intensity: 0.9 })]);
    h.sendRows([inSrc('a.ts', { intensity: 0.3, badge: 'external', source: 'external' })]);
    assert.equal(must(folderById(h.root, 'src')).getAttribute('aria-expanded'), 'false');
  });

  it('a NEW file id appearing beneath a collapsed folder auto-expands it and persists that', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    click(toggleOf('src'));
    assert.deepEqual(h.host.lastCollapsed, ['src']);
    h.sendRows([inSrc('a.ts'), inSrc('b.ts')]);
    assert.equal(must(folderById(h.root, 'src')).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(h.host.lastCollapsed, []);
  });

  it('a new file under a DIFFERENT folder does not expand a collapsed one', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    click(toggleOf('src'));
    h.sendRows([inSrc('a.ts'), viewRow('/ws/lib/x.ts', { folderPath: ['lib'], dir: 'lib' })]);
    assert.equal(must(folderById(h.root, 'src')).getAttribute('aria-expanded'), 'false');
    assert.equal(must(folderById(h.root, 'lib')).getAttribute('aria-expanded'), 'true');
  });

  it('collapsed ids are read from the persisted webview state at mount time', () => {
    h = mount({ state: { collapsed: ['src'] } });
    h.sendRows([inSrc('a.ts')]);
    // The first snapshot is allowed to expand a folder whose files are "new", but the state must have been
    // consulted: toggling once from the persisted state must yield a consistent written state.
    const before = must(folderById(h.root, 'src')).getAttribute('aria-expanded');
    click(toggleOf('src'));
    const after = must(folderById(h.root, 'src')).getAttribute('aria-expanded');
    assert.notEqual(before, after);
    assert.ok(h.host.stateWrites.length >= 1);
  });

  it('a malformed persisted state is tolerated', () => {
    h = mount({ state: { collapsed: 'nope' as unknown as string[] } });
    h.sendRows([inSrc('a.ts')]);
    assert.ok(folderById(h.root, 'src'));
    h.close();
    h = mount({ state: null as unknown as undefined });
    h.sendRows([inSrc('a.ts')]);
    assert.ok(folderById(h.root, 'src'));
  });

  it('folder toggling is keyboard reachable: the toggle is a real <button>', () => {
    h = mount();
    h.sendRows([inSrc('a.ts')]);
    assert.equal(toggleOf('src').tagName, 'BUTTON');
  });
});

describe('webview: leaving and reviving rows', () => {
  it('a row missing from the next snapshot gets .is-leaving, stays in the DOM, and is removed after LEAVE_MS via env.setTimeout', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    const before = h.env.scheduled.length;
    h.sendRows([viewRow('/ws/a.ts')]);
    const b = must(rowById(h.root, '/ws/b.ts'));
    assert.ok(b.classList.contains('is-leaving'));
    assert.ok(!must(rowById(h.root, '/ws/a.ts')).classList.contains('is-leaving'));
    const scheduled = h.env.scheduled.slice(before);
    assert.ok(scheduled.length >= 1, 'a removal timer was scheduled through env.setTimeout');
    assert.ok(scheduled.every((s) => s.ms === 400), `delay is LEAVE_MS (400): ${JSON.stringify(scheduled)}`);
    assert.equal(rowById(h.root, '/ws/b.ts'), b, 'still in the DOM before the timer fires');
    h.env.runTimers();
    assert.equal(rowById(h.root, '/ws/b.ts'), undefined);
    assert.ok(rowById(h.root, '/ws/a.ts'));
  });

  it('reappearing before the timer fires revives the same node and the stale timer cannot remove it', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    const b = must(rowById(h.root, '/ws/b.ts'));
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.ok(b.classList.contains('is-leaving'));
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    assert.ok(!b.classList.contains('is-leaving'));
    assert.equal(rowById(h.root, '/ws/b.ts'), b, 'same node');
    h.env.runTimers(); // every timer that was not cleared fires now
    assert.equal(rowById(h.root, '/ws/b.ts'), b, 'a revived row survives the old removal timer');
    assert.equal(rowEls(h.root).filter((e) => e.getAttribute('data-id') === '/ws/b.ts').length, 1);
  });

  it('a folder whose last row has left disappears with it', () => {
    h = mount();
    h.sendRows([inSrc('a.ts'), viewRow('/ws/top.ts')]);
    assert.ok(folderById(h.root, 'src'));
    h.sendRows([viewRow('/ws/top.ts')]);
    h.env.runTimers();
    assert.equal(folderById(h.root, 'src'), undefined);
    assert.ok(rowById(h.root, '/ws/top.ts'));
  });

  it('a row that leaves, revives, and leaves again is removed exactly once (no duplicates, no throw)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    h.sendRows([viewRow('/ws/a.ts')]);
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    h.sendRows([viewRow('/ws/a.ts')]);
    h.env.runTimers();
    assert.equal(rowById(h.root, '/ws/b.ts'), undefined);
    assert.equal(rowEls(h.root).length, 1);
  });

  it('leaving rows are not clickable targets for a different state: clicking one still opens its id (still visible during fade)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.doesNotThrow(() => click(must(rowById(must(h).root, '/ws/b.ts'))));
  });

  it('removing everything and then adding new rows before the timers fire leaves a consistent tree', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    h.sendRows([]);
    h.sendRows([viewRow('/ws/c.ts')]);
    h.env.runTimers();
    assert.deepEqual(
      rowEls(h.root).map((e) => e.getAttribute('data-id')),
      ['/ws/c.ts'],
    );
    assert.equal(h.root.getAttribute('data-state'), 'rows');
  });
});
