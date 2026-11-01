import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { allElements, click, folderEls, mount, rowById, rowEls, text } from '../support/dom';
import type { Harness } from '../support/dom';
import { snapshotOf, viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import { mountApp } from '../../src/webview/app';

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "' onmouseover='alert(1)",
  '</li></ul><li class="fs-row">injected',
  '<svg/onload=alert(1)>',
  '&lt;b&gt;already escaped&lt;/b&gt;',
  '`${alert(1)}`',
  '‮evil.ts',
  '日本語/😀/ملف.ts',
  'a\\b\'c"d',
  '<style>*{display:none}</style>',
  'javascript:alert(1)',
  '[data-id="x"], *',
  ']"] , body',
];

/** Tags the renderer is allowed to create. */
const ALLOWED_TAGS = new Set(['DIV', 'UL', 'LI', 'BUTTON', 'SPAN', 'I']);

function assertInert(root: HTMLElement): void {
  for (const el of allElements(root)) {
    if (el === root) continue;
    assert.ok(ALLOWED_TAGS.has(el.tagName), `unexpected element <${el.tagName.toLowerCase()}> was created`);
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr), `inline event handler attribute ${attr}`);
      assert.ok(!['src', 'href', 'srcdoc', 'action', 'formaction', 'xlink:href'].includes(attr.toLowerCase()), `navigational attribute ${attr}`);
    }
  }
  assert.equal(root.querySelectorAll('img, script, iframe, style, svg, a, form, input').length, 0);
}

describe('webview: hostile file and folder names render as text only', () => {
  for (const evil of HOSTILE) {
    it(`name/dir/folder ${JSON.stringify(evil)}`, () => {
      h = mount();
      const id = `/ws/${evil}/${evil}`;
      h.sendRows([
        viewRow(id, { name: evil, dir: evil, folderPath: [evil], badge: evil, tooltip: evil }),
        viewRow(`/ws/plain.ts`, { name: 'plain.ts' }),
      ]);
      assertInert(h.root);
      const row = must(rowById(h.root, id));
      assert.equal(text(row, 'span.fs-name'), evil, 'the name round-trips as text');
      assert.equal(text(row, 'span.fs-dir'), evil);
      assert.equal(text(row, 'span.fs-badge'), evil);
      const labels = [...h.root.querySelectorAll('.fs-folder-label')].map((e) => e.textContent);
      assert.ok(labels.includes(evil), `folder label ${JSON.stringify(labels)}`);
      assert.equal(rowEls(h.root).length, 2, 'no extra rows were injected through the markup');
    });
  }

  it('a row with a selector-breaking id can be updated, found and removed (lookups are escaped / attribute-based)', () => {
    h = mount();
    const id = '/ws/[data-id="x"], *\\\'/]"].ts';
    const mk = (intensity: number) => viewRow(id, { intensity, folderPath: ['f"o\\o'], dir: 'f"o\\o' });
    h.sendRows([mk(0.2)]);
    assert.doesNotThrow(() => h?.sendRows([mk(0.8)]));
    assert.doesNotThrow(() => h?.sendRows([mk(0.9)]));
    const matches = rowEls(h.root).filter((e) => e.getAttribute('data-id') === id);
    assert.equal(matches.length, 1, 'updated in place, not duplicated');
    assert.equal(must(matches[0]).style.getPropertyValue('--fs-level'), '0.9');
    h.sendRows([]);
    assert.doesNotThrow(() => h?.env.runTimers());
    assert.equal(rowEls(h.root).length, 0);
  });

  it('hostile names with many rows: every row keeps its own text', () => {
    h = mount();
    const rows = HOSTILE.map((evil, i) => viewRow(`/ws/d/${i}`, { name: evil, folderPath: ['d'], dir: 'd' }));
    h.sendRows(rows);
    assertInert(h.root);
    const names = new Set(rowEls(h.root).map((e) => text(e, 'span.fs-name')));
    assert.equal(names.size, HOSTILE.length);
    for (const evil of HOSTILE) assert.ok(names.has(evil));
  });

  it('hostile text never ends up in attributes that are interpreted (aria-label / title are data)', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts', { name: '"><img src=x onerror=alert(1)>', tooltip: '"><img src=x onerror=alert(1)>' })]);
    assertInert(h.root);
    const el = must(rowEls(must(h).root)[0]);
    assert.ok(el.getAttributeNames().every((n) => !/^on/i.test(n)));
  });

  it('colour overrides are only ever applied through style.setProperty on validated hex values', () => {
    h = mount();
    // parseHostMessage rejects anything that is not a hex colour, so the snapshot is ignored wholesale
    h.sendRows([viewRow('/ws/a.ts')], { colors: { edited: 'red; background: url(http://evil)', referenced: '' } });
    assert.equal(h.root.style.getPropertyValue('--fs-edited-override'), '');
    assert.ok(!(h.root.getAttribute('style') ?? '').includes('evil'));
    assert.equal(rowEls(h.root).length, 0, 'a snapshot with an invalid colour is dropped as malformed');
  });
});

describe('webview: no HTML sinks and no inline style attributes at runtime', () => {
  it('never assigns innerHTML / outerHTML, never calls insertAdjacentHTML / document.write, never sets a style attribute', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
    const win = dom.window as unknown as Window & typeof globalThis;
    const sinks: string[] = [];
    const proto = win.Element.prototype;
    for (const prop of ['innerHTML', 'outerHTML'] as const) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(proto, prop, {
          ...desc,
          set(this: Element, v: string) {
            sinks.push(`${prop}=${String(v).slice(0, 40)}`);
            orig.call(this, v);
          },
        });
      }
    }
    const origInsert = proto.insertAdjacentHTML;
    proto.insertAdjacentHTML = function (this: Element, ...args: Parameters<Element['insertAdjacentHTML']>) {
      sinks.push('insertAdjacentHTML');
      return origInsert.apply(this, args);
    };
    const origSetAttr = proto.setAttribute;
    proto.setAttribute = function (this: Element, name: string, value: string) {
      if (name.toLowerCase() === 'style') sinks.push(`setAttribute(style,${value.slice(0, 30)})`);
      return origSetAttr.call(this, name, value);
    };
    const origWrite = win.document.write.bind(win.document);
    win.document.write = (...args: string[]) => {
      sinks.push('document.write');
      origWrite(...args);
    };
    const origRange = win.document.createRange.bind(win.document);
    win.document.createRange = () => {
      sinks.push('createRange');
      return origRange();
    };

    const root = must(win.document.getElementById('app'));
    const posted: unknown[] = [];
    const app = mountApp(
      root,
      { postMessage: (m) => posted.push(m), getState: () => undefined, setState: () => undefined },
      { reducedMotion: () => false, onReducedMotionChange: () => () => undefined, setTimeout: () => 1, clearTimeout: () => undefined },
    );
    for (let i = 1; i <= 3; i++) {
      app.handleMessage(
        JSON.parse(
          JSON.stringify({
            type: 'snapshot',
            snapshot: snapshotOf(
              [viewRow('/ws/a/<b>.ts', { name: '<b>.ts', folderPath: ['a'], dir: 'a', intensity: i / 4 }), viewRow('/ws/x.ts', { role: 'referenced', source: null })],
              { seq: i, colors: { edited: '#ff0000', referenced: '#00ff00' } },
            ),
          }),
        ),
      );
    }
    app.handleMessage({ type: 'snapshot', snapshot: snapshotOf([], { seq: 9, enabled: false }) });
    app.dispose();
    dom.window.close();
    assert.deepEqual(sinks, [], `forbidden DOM sinks were used: ${sinks.join(' | ')}`);
  });
});

describe('webview: malformed messages are ignored', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    0,
    1,
    '',
    'snapshot',
    true,
    [],
    [1, 2, 3],
    {},
    { type: 'snapshot' },
    { type: 'snapshot', snapshot: null },
    { type: 'snapshot', snapshot: {} },
    { type: 'snapshot', snapshot: { v: 2, seq: 1, enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: [] } },
    { type: 'snapshot', snapshot: { v: 1, seq: 'x', enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: [] } },
    { type: 'snapshot', snapshot: { v: 1, seq: 1, enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: [{ id: 5 }] } },
    { type: 'snapshot', snapshot: { v: 1, seq: 1, enabled: true, animate: true, colors: { edited: 'red', referenced: '' }, rows: [] } },
    { type: 'open', id: '/ws/a.ts' },
    { type: 'ready' },
    { type: 'exec', command: 'rm -rf /' },
  ];

  it('none of them throws, changes the DOM, advances lastSeq, or posts anything', () => {
    h = mount();
    h.sendRows([viewRow('/ws/keep.ts')]);
    const seq = h.app.lastSeq;
    const html = h.root.innerHTML;
    const posted = h.host.messages.length;
    for (const g of garbage) {
      assert.doesNotThrow(() => h?.app.handleMessage(g), JSON.stringify(g));
    }
    assert.equal(h.root.innerHTML, html);
    assert.equal(h.app.lastSeq, seq);
    assert.equal(h.host.messages.length, posted);
  });

  it('garbage as the very first message leaves the app in its empty state', () => {
    h = mount();
    for (const g of garbage) h.app.handleMessage(g);
    assert.equal(h.root.getAttribute('data-state'), 'empty');
    assert.ok(Number.isFinite(h.app.lastSeq));
  });

  it('a snapshot with 501 rows is rejected as a whole', () => {
    h = mount();
    h.sendRows([viewRow('/ws/keep.ts')]);
    h.sendRows(Array.from({ length: 501 }, (_, i) => viewRow(`/ws/f${i}.ts`)));
    assert.deepEqual(
      rowEls(h.root).map((e) => e.getAttribute('data-id')),
      ['/ws/keep.ts'],
    );
  });

  it('messages with prototype-pollution keys are harmless', () => {
    h = mount();
    h.app.handleMessage(JSON.parse('{"type":"snapshot","__proto__":{"polluted":1},"snapshot":{"__proto__":{"polluted":1}}}'));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('a click on an element that is not a row (e.g. text node target, detached node) does nothing', () => {
    h = mount();
    h.sendRows([viewRow('/ws/a.ts')]);
    const detached = h.document.createElement('span');
    assert.doesNotThrow(() => detached.dispatchEvent(new h!.dom.window.MouseEvent('click', { bubbles: true })));
    const t = h.document.createTextNode('x');
    h.root.appendChild(t);
    assert.doesNotThrow(() => t.parentNode?.dispatchEvent(new h!.dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(h.host.opens(), []);
    folderEls(h.root);
    click(h.root);
    assert.deepEqual(h.host.opens(), []);
  });
});
