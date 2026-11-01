import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { click, key, mount, rowById, rowEls } from '../support/dom';
import type { Harness } from '../support/dom';
import { viewRow } from '../support/builders';
import { must } from '../support/fixtures';

let h: Harness | undefined;
afterEach(() => {
  try {
    h?.close();
  } catch {
    /* closing twice is exercised on purpose in some tests */
  }
  h = undefined;
});

describe('webview: dispose (DESIGN 12: view hidden / re-shown / disposed)', () => {
  it('dispose is idempotent and never throws', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    h.app.dispose();
    assert.doesNotThrow(() => h?.app.dispose());
  });

  it('messages arriving after dispose are ignored without throwing and do not touch the DOM', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    const html = h.root.innerHTML;
    h.app.dispose();
    assert.doesNotThrow(() => h?.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]));
    assert.doesNotThrow(() => h?.app.handleMessage(null));
    assert.doesNotThrow(() => h?.app.handleMessage({ garbage: true }));
    assert.equal(h.root.innerHTML, html);
  });

  it('no further messages are posted after dispose: clicks and keys on rows are inert', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    const row = must(rowById(h.root, '/ws/a.ts'));
    h.app.dispose();
    const before = h.host.messages.length;
    click(row);
    key(row, 'Enter');
    assert.equal(h.host.messages.length, before);
  });

  it('the reduced-motion subscription is released exactly once per subscription', () => {
    h = mount();
    assert.ok(h.env.subscriptions >= 1, 'the app subscribes to reduced-motion changes');
    assert.equal(h.env.listenerCount, h.env.subscriptions - h.env.unsubscriptions);
    h.app.dispose();
    assert.equal(h.env.listenerCount, 0, 'dispose unsubscribes');
    assert.doesNotThrow(() => h?.env.setReduced(true));
    assert.ok(h.env.unsubscriptions <= h.env.subscriptions);
  });

  it('pending leave timers do not run app code after dispose (they are cleared or inert)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts'), viewRow('/ws/b.ts')]);
    h.sendRows([viewRow('/ws/a.ts')]);
    assert.ok(h.env.pending >= 1, 'a removal timer is pending');
    h.app.dispose();
    assert.doesNotThrow(() => h?.env.runTimers());
    assert.equal(h.env.pending, 0);
  });

  it('dispose with nothing rendered and with a disabled snapshot works', () => {
    h = mount();
    assert.doesNotThrow(() => h?.app.dispose());
    h = mount();
    h.sendRows([], { enabled: false });
    assert.doesNotThrow(() => h?.app.dispose());
  });
});

describe('webview: two views do not interfere', () => {
  it('state and listeners are per mount', () => {
    const a = mount();
    const b = mount();
    try {
      a.sendRows([viewRow('/ws/a.ts')]);
      b.sendRows([viewRow('/ws/b.ts')]);
      assert.deepEqual(rowEls(a.root).map((e) => e.getAttribute('data-id')), ['/ws/a.ts']);
      assert.deepEqual(rowEls(b.root).map((e) => e.getAttribute('data-id')), ['/ws/b.ts']);
      click(must(rowById(a.root, '/ws/a.ts')));
      assert.deepEqual(a.host.opens(), ['/ws/a.ts']);
      assert.deepEqual(b.host.opens(), []);
      a.app.dispose();
      b.sendRows([viewRow('/ws/b.ts'), viewRow('/ws/c.ts')]);
      assert.equal(rowEls(b.root).length, 2, 'disposing one app leaves the other working');
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('webview: re-show after hide (the host re-sends a full snapshot into a fresh document)', () => {
  it('a brand-new mount reaches the same DOM from the same snapshot', () => {
    const rows = [viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' }), viewRow('/ws/src/b.ts', { folderPath: ['src'], dir: 'src', role: 'referenced', source: null, badge: '×2 refs', refCount: 2 })];
    const first = mount();
    first.sendRows(rows, { seq: 100 });
    const second = mount();
    second.sendRows(rows, { seq: 1 });
    try {
      const norm = (root: HTMLElement): string => root.innerHTML;
      assert.equal(norm(first.root), norm(second.root), 'rendering is a pure function of the snapshot');
    } finally {
      first.close();
      second.close();
    }
  });

  it('snapshots are idempotent: sending the same snapshot twice changes nothing', () => {
    h = mount();
    const rows = [viewRow('/ws/a.ts'), viewRow('/ws/d/b.ts', { folderPath: ['d'], dir: 'd' })];
    h.sendRows(rows, { seq: 3 });
    const html = h.root.innerHTML;
    h.sendRows(rows, { seq: 3 });
    assert.equal(h.root.innerHTML, html);
  });
});
