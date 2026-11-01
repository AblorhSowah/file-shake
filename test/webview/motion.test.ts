import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mount, rowById, rowEls, text } from '../support/dom';
import type { Harness } from '../support/dom';
import { viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import { JSDOM } from 'jsdom';
import { mountApp } from '../../src/webview/app';
import type { App } from '../../src/webview/app';

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const shaking = (root: ParentNode): string[] =>
  rowEls(root)
    .filter((e) => e.classList.contains('is-shaking'))
    .map((e) => e.getAttribute('data-id') ?? '');

describe('webview: motion (DESIGN 11)', () => {
  it('data-motion="on" when animate is true and the OS does not ask for reduced motion', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')], { animate: true });
    assert.equal(h.root.getAttribute('data-motion'), 'on');
  });

  it('.is-shaking iff motion is on AND the row is active AND its intensity is above 0', () => {
    h = mount();
    h.sendRows(
      [
        viewRow('/ws/active.ts', { intensity: 0.5 }),
        viewRow('/ws/zero.ts', { intensity: 0, phase: 'active', shake: { amp: 0, dur: 160, rot: 0 } }),
        viewRow('/ws/idle.ts', { intensity: 0, phase: 'idle', shake: { amp: 0, dur: 160, rot: 0 } }),
        viewRow('/ws/idle-but-nonzero.ts', { intensity: 0.4, phase: 'idle' }),
        viewRow('/ws/ref.ts', { role: 'referenced', source: null, intensity: 0.3, refCount: 2, badge: '×2 refs' }),
      ],
      { animate: true },
    );
    assert.deepEqual(shaking(h.root).sort(), ['/ws/active.ts', '/ws/ref.ts']);
  });

  it('snapshot.animate=false: data-motion="off", zero shaking rows, but colour, badge, meter and level are still there', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.8 }), viewRow('/ws/b.ts', { role: 'referenced', source: null, intensity: 0.6, badge: '×4 refs', refCount: 4 })], { animate: false });
    assert.equal(h.root.getAttribute('data-motion'), 'off');
    assert.deepEqual(shaking(h.root), []);
    const a = must(rowById(h.root, '/ws/a.ts'));
    assert.ok(a.classList.contains('fs-row--edited'));
    assert.equal(a.getAttribute('data-role'), 'edited');
    assert.equal(text(a, 'span.fs-badge'), 'typing');
    assert.ok(a.querySelector('span.fs-meter > i'));
    assert.equal(a.style.getPropertyValue('--fs-level'), '0.8', 'the meter still has its level');
    assert.equal(text(rowById(h.root, '/ws/b.ts'), 'span.fs-badge'), '×4 refs');
  });

  it('the OS reduced-motion preference at mount time disables shaking too', () => {
    h = mount({ reduced: true });
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.9 })], { animate: true });
    assert.equal(h.root.getAttribute('data-motion'), 'off');
    assert.deepEqual(shaking(h.root), []);
    assert.equal(must(rowById(h.root, '/ws/a.ts')).style.getPropertyValue('--fs-level'), '0.9');
  });

  it('the preference changing while the view is open applies immediately, without a new snapshot', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.9 })], { animate: true });
    assert.deepEqual(shaking(h.root), ['/ws/a.ts']);
    h.env.setReduced(true);
    assert.equal(h.root.getAttribute('data-motion'), 'off');
    assert.deepEqual(shaking(h.root), []);
    h.env.setReduced(false);
    assert.equal(h.root.getAttribute('data-motion'), 'on');
    assert.deepEqual(shaking(h.root), ['/ws/a.ts']);
  });

  it('the next snapshot honours the current preference', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')], { animate: true });
    h.env.setReduced(true);
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.95 })], { animate: true });
    assert.equal(h.root.getAttribute('data-motion'), 'off');
    assert.deepEqual(shaking(h.root), []);
  });

  it('a row that becomes idle stops shaking, and one that becomes active starts', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.5 })]);
    assert.deepEqual(shaking(h.root), ['/ws/a.ts']);
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0, phase: 'idle', shake: { amp: 0, dur: 160, rot: 0 } })]);
    assert.deepEqual(shaking(h.root), []);
    assert.ok(must(rowById(h.root, '/ws/a.ts')).classList.contains('is-idle'));
    h.sendRows([viewRow('/ws/a.ts', { intensity: 0.7 })]);
    assert.deepEqual(shaking(h.root), ['/ws/a.ts']);
    assert.ok(!must(rowById(h.root, '/ws/a.ts')).classList.contains('is-idle'));
  });

  it('animate=false removes shaking from rows that were already shaking', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')], { animate: true });
    assert.deepEqual(shaking(h.root), ['/ws/a.ts']);
    h.sendRows([viewRow('/ws/a.ts')], { animate: false });
    assert.deepEqual(shaking(h.root), []);
    assert.equal(h.root.getAttribute('data-motion'), 'off');
  });

  it('the default environment reads prefers-reduced-motion from matchMedia', () => {
    // No FakeEnv override here: mountApp must build its own env from the window.
    const dom = new JSDOM('<!doctype html><div id="app"></div>');
    const win = dom.window as unknown as { matchMedia?: (q: string) => unknown; document: Document };
    const listeners: Array<() => void> = [];
    win.matchMedia = (q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: (_t: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => undefined,
    });
    const root = must(win.document.getElementById('app'));
    const posted: unknown[] = [];
    const app = mountAppDefault(root, posted);
    app.handleMessage({ type: 'snapshot', snapshot: { v: 1, seq: 1, enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: [JSON.parse(JSON.stringify(viewRow('/ws/a.ts')))] } });
    assert.equal(root.getAttribute('data-motion'), 'off');
    assert.equal(root.querySelectorAll('.is-shaking').length, 0);
    app.dispose();
    dom.window.close();
  });

  it('without matchMedia at all the app still works (motion on)', () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>');
    const root = must(dom.window.document.getElementById('app'));
    const app = mountAppDefault(root, []);
    app.handleMessage({ type: 'snapshot', snapshot: { v: 1, seq: 1, enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: [JSON.parse(JSON.stringify(viewRow('/ws/a.ts')))] } });
    assert.equal(root.getAttribute('data-motion'), 'on');
    app.dispose();
    dom.window.close();
  });
});

// --- helpers ---------------------------------------------------------------------------------

function mountAppDefault(root: HTMLElement, posted: unknown[]): App {
  return mountApp(root, {
    postMessage: (m) => {
      posted.push(m);
    },
    getState: () => undefined,
    setState: () => undefined,
  });
}
