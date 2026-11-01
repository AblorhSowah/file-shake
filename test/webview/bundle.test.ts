// Executes the REAL shipped browser bundle (dist/webview.js, built by `npm run build`) inside jsdom, in the page that
// buildWebviewHtml produces, with a stubbed acquireVsCodeApi. This covers src/webview/main.ts, which app-level tests
// cannot reach, and proves the esbuild IIFE has no stray Node/vscode dependency.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildWebviewHtml } from '../../src/core/webviewHtml';
import { REPO_ROOT, must } from '../support/fixtures';
import { snapshotOf, viewRow } from '../support/builders';

const bundlePath = join(REPO_ROOT, 'dist', 'webview.js');
const haveBundle = existsSync(bundlePath);
const skipReason = 'dist/webview.js is missing: run `npm run build` first';

/** Objects built inside the jsdom window live in another realm; compare their JSON form with strict deepEqual. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

interface Page {
  dom: JSDOM;
  posted: unknown[];
  stateWrites: unknown[];
  send(snapshot: unknown): void;
  root(): HTMLElement;
}

let current: Page | undefined;
afterEach(() => {
  current?.dom.window.close();
  current = undefined;
});

function load(initialState?: unknown): Page {
  const html = buildWebviewHtml({
    cspSource: 'vscode-webview-resource:',
    nonce: 'n'.repeat(32),
    scriptUri: 'vscode-resource:/dist/webview.js',
    styleUri: 'vscode-resource:/media/webview.css',
    title: 'File Shake',
  });
  // Scripts from the document are not fetched (resources: undefined); the bundle is evaluated by hand below.
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const posted: unknown[] = [];
  const stateWrites: unknown[] = [];
  let state: unknown = initialState;
  Object.defineProperty(dom.window, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      postMessage: (m: unknown) => {
        posted.push(m);
      },
      getState: () => state,
      setState: (s: unknown) => {
        state = s;
        stateWrites.push(s);
      },
    }),
  });
  dom.window.eval(readFileSync(bundlePath, 'utf8'));
  const page: Page = {
    dom,
    posted,
    stateWrites,
    send: (snapshot) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: JSON.parse(JSON.stringify(snapshot)) } }));
    },
    root: () => must(dom.window.document.getElementById('app')) as HTMLElement,
  };
  current = page;
  return page;
}

describe('dist/webview.js executed in a page built by buildWebviewHtml', () => {
  it('the bundle exists, is small, and is a self-contained script', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const text = readFileSync(bundlePath, 'utf8');
    assert.ok(statSync(bundlePath).size < 60_000, `bundle is ${statSync(bundlePath).size} bytes`);
    for (const re of [/\brequire\(/, /\bimport\s*\(/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /importScripts/, /\beval\s*\(/, /new Function\(/, /\binnerHTML\b/, /https?:\/\/(?!www\.w3\.org)/]) {
      assert.ok(!re.test(text), `bundle must not contain ${re}`);
    }
    assert.ok(!/require\("vscode"\)|from "vscode"|from 'vscode'/.test(text));
    assert.ok(!/picomatch|jsonc-parser/.test(text), 'node-only libraries must not leak into the browser bundle');
  });

  it('boots, posts {type:"ready"} exactly once and shows the empty state', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    assert.deepEqual(plain(p.posted), [{ type: 'ready' }]);
    assert.equal(p.root().getAttribute('data-state'), 'empty');
    assert.ok(['on', 'off'].includes(p.root().getAttribute('data-motion') ?? ''));
  });

  it('renders a snapshot received through a window message event, with the documented CSS variables', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(snapshotOf([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })], { seq: 1 }));
    assert.equal(p.root().getAttribute('data-state'), 'rows');
    const row = must(p.root().querySelector<HTMLElement>('li.fs-row'));
    assert.equal(row.getAttribute('data-id'), '/ws/src/a.ts');
    assert.equal(row.style.getPropertyValue('--fs-amp'), '2.25px');
    assert.equal(row.style.getPropertyValue('--fs-dur'), '110ms');
    assert.equal(row.style.getPropertyValue('--fs-rot'), '0.7deg');
  });

  it('a click on a row posts {type:"open", id}', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(snapshotOf([viewRow('/ws/a.ts')], { seq: 1 }));
    must(p.root().querySelector('li.fs-row')).dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(plain(p.posted.slice(-1)), [{ type: 'open', id: '/ws/a.ts' }]);
  });

  it('collapsing a folder persists {collapsed:[id]} through vscode.setState', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.send(snapshotOf([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })], { seq: 1 }));
    must(p.root().querySelector('button.fs-folder-toggle')).dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(plain(p.stateWrites.slice(-1)), [{ collapsed: ['src'] }]);
  });

  it('restores collapsed folders from vscode.getState, ignoring junk state', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    for (const junk of [undefined, null, 42, 'x', { collapsed: 'nope' }, { collapsed: [1, 2, null] }, { other: true }]) {
      const p = load(junk);
      p.send(snapshotOf([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })], { seq: 1 }));
      assert.equal(p.root().getAttribute('data-state'), 'rows', JSON.stringify(junk));
      p.dom.window.close();
    }
    const p = load({ collapsed: ['src', 5, 'lib'] });
    p.send(snapshotOf([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })], { seq: 1 }));
    assert.equal(must(p.root().querySelector('li.fs-folder')).getAttribute('aria-expanded'), 'false', 'a restored collapsed folder stays collapsed after the first snapshot');
  });

  it('ignores malformed window messages (other extensions, devtools, garbage)', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    for (const data of [null, undefined, 'hello', 7, [], {}, { type: 'snapshot' }, { type: 'snapshot', snapshot: { v: 9 } }, { command: 'x' }]) {
      assert.doesNotThrow(() => p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data })));
    }
    assert.deepEqual(plain(p.posted), [{ type: 'ready' }]);
    assert.equal(p.root().getAttribute('data-state'), 'empty');
  });

  it('reports uncaught page errors and unhandled rejections to the host as {type:"error"}', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    p.dom.window.dispatchEvent(new p.dom.window.ErrorEvent('error', { message: 'boom' }));
    const err = p.posted.find((m): m is { type: 'error'; message: string } => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'error');
    assert.ok(err, JSON.stringify(p.posted));
    assert.match(err.message, /boom/);
    // unhandledrejection: jsdom has no PromiseRejectionEvent; a plain Event with a `reason` is enough for the listener
    const ev = new p.dom.window.Event('unhandledrejection');
    Object.defineProperty(ev, 'reason', { value: new Error('rejected!') });
    p.dom.window.dispatchEvent(ev);
    assert.ok(p.posted.some((m) => typeof m === 'object' && m !== null && (m as { message?: string }).message?.includes('rejected!')));
  });

  it('a hostile file name renders as text even in the shipped bundle', (t) => {
    if (!haveBundle) return t.skip(skipReason);
    const p = load();
    const evil = '<img src=x onerror=alert(1)>.ts';
    p.send(snapshotOf([viewRow('/ws/evil', { name: evil })], { seq: 1 }));
    assert.equal(p.root().querySelectorAll('img').length, 0);
    assert.equal(must(p.root().querySelector('.fs-name')).textContent, evil);
  });
});
