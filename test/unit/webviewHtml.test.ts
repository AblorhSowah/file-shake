import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { buildWebviewHtml, makeNonce } from '../../src/core/webviewHtml';
import { must } from '../support/fixtures';

const P = {
  cspSource: 'vscode-webview-resource:',
  nonce: 'abcdef0123456789abcdef0123456789',
  scriptUri: 'vscode-resource:/ext/dist/webview.js',
  styleUri: 'vscode-resource:/ext/media/webview.css',
  title: 'File Shake',
};

describe('makeNonce', () => {
  it('16 bytes -> 32 lower-case hex characters, in order, zero padded', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    assert.equal(makeNonce(() => bytes), '000102030405060708090a0b0c0d0e0f');
    assert.equal(makeNonce(() => new Uint8Array(16).fill(255)), 'f'.repeat(32));
    assert.equal(makeNonce(() => new Uint8Array(16)), '0'.repeat(32));
  });

  it('asks for exactly 16 bytes', () => {
    let asked = -1;
    makeNonce((n) => {
      asked = n;
      return new Uint8Array(n);
    });
    assert.equal(asked, 16);
  });

  it('with real crypto bytes: 32 hex chars and different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = makeNonce((len) => randomBytes(len));
      assert.match(n, /^[0-9a-f]{32}$/);
      seen.add(n);
    }
    assert.equal(seen.size, 50);
  });
});

describe('buildWebviewHtml', () => {
  const html = buildWebviewHtml(P);

  it('is an HTML5 document with charset and viewport meta', () => {
    assert.match(html, /^\s*<!doctype html>/i);
    assert.ok(html.includes('<meta charset="UTF-8">'));
    assert.match(html, /<meta name="viewport"[^>]*>/);
  });

  it('carries the exact documented CSP', () => {
    const expected = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${P.cspSource}; script-src 'nonce-${P.nonce}'; img-src ${P.cspSource} data:; font-src ${P.cspSource};">`;
    assert.ok(html.includes(expected), html);
  });

  it('CSP is strict: no unsafe-*, no wildcard, no remote scheme, no connect/frame/object relaxations', () => {
    const csp = must(/Content-Security-Policy" content="([^"]*)"/.exec(html))[1] as string;
    assert.ok(!/unsafe-/i.test(csp), csp);
    assert.ok(!/\*/.test(csp), csp);
    assert.ok(!/https?:/i.test(csp), csp);
    assert.ok(csp.startsWith("default-src 'none'"));
    assert.ok(!/connect-src|frame-src|object-src|worker-src/.test(csp), 'default-src none already denies these');
  });

  it('exactly one script element, nonce-bound, loaded from scriptUri; no inline script', () => {
    const dom = new JSDOM(html);
    const scripts = [...dom.window.document.querySelectorAll('script')];
    assert.equal(scripts.length, 1);
    const s = must(scripts[0]);
    assert.equal(s.getAttribute('nonce'), P.nonce);
    assert.equal(s.getAttribute('src'), P.scriptUri);
    assert.equal(s.textContent, '');
    assert.ok(html.includes(`<script nonce="${P.nonce}" src="${P.scriptUri}"></script>`));
  });

  it('exactly one stylesheet link and no <style> / style attributes', () => {
    const dom = new JSDOM(html);
    const links = [...dom.window.document.querySelectorAll('link')];
    assert.equal(links.length, 1);
    assert.equal(must(links[0]).getAttribute('rel'), 'stylesheet');
    assert.equal(must(links[0]).getAttribute('href'), P.styleUri);
    assert.equal(dom.window.document.querySelectorAll('style').length, 0);
    assert.equal(dom.window.document.querySelectorAll('[style]').length, 0);
  });

  it('has the #app mount point', () => {
    const dom = new JSDOM(html);
    const app = dom.window.document.getElementById('app');
    assert.ok(app);
    assert.equal(app.tagName, 'DIV');
    assert.ok(html.includes('<div id="app"></div>'));
  });

  it('no remote URLs, no inline event handlers, no iframes / objects / forms', () => {
    assert.ok(!/https?:\/\//i.test(html), 'no remote resources');
    const dom = new JSDOM(html);
    for (const el of dom.window.document.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `inline handler ${attr} on <${el.tagName}>`);
    }
    assert.equal(dom.window.document.querySelectorAll('iframe,object,embed,form,base').length, 0);
  });

  it('escapes hostile values so they cannot break out of attributes or add elements', () => {
    const evil = buildWebviewHtml({
      cspSource: P.cspSource,
      nonce: P.nonce,
      scriptUri: 'x.js"><script>alert(1)</script><b a="',
      styleUri: 'y.css" onload="alert(2)',
      title: '</title><script>alert(3)</script>&"\'',
    });
    const dom = new JSDOM(evil);
    const d = dom.window.document;
    const scripts = [...d.querySelectorAll('script')];
    assert.equal(scripts.length, 1, 'no injected script element');
    assert.equal(must(scripts[0]).getAttribute('src'), 'x.js"><script>alert(1)</script><b a="', 'the value survives as data');
    assert.equal(must(scripts[0]).textContent, '');
    const link = must(d.querySelector('link'));
    assert.equal(link.getAttribute('href'), 'y.css" onload="alert(2)');
    assert.equal(link.hasAttribute('onload'), false);
    assert.equal(d.title, '</title><script>alert(3)</script>&"\'');
    assert.equal(d.querySelectorAll('b').length, 0);
  });

  it('is deterministic: same input, same output', () => {
    assert.equal(buildWebviewHtml(P), buildWebviewHtml(P));
  });

  it('a different nonce changes both the CSP and the script tag consistently', () => {
    const other = buildWebviewHtml({ ...P, nonce: 'ffffffffffffffffffffffffffffffff' });
    assert.ok(other.includes("script-src 'nonce-ffffffffffffffffffffffffffffffff'"));
    assert.ok(other.includes('<script nonce="ffffffffffffffffffffffffffffffff"'));
    assert.ok(!other.includes(P.nonce));
  });
});
