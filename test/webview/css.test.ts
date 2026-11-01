import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { click, folderById, mount } from '../support/dom';
import type { Harness } from '../support/dom';
import { REPO_ROOT, must } from '../support/fixtures';
import { viewRow } from '../support/builders';

const raw = readFileSync(join(REPO_ROOT, 'media', 'webview.css'), 'utf8');
/** Comments stripped, whitespace collapsed, lower-cased: stable against formatting changes. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').toLowerCase();

function block(selectorStart: string): string {
  const i = css.indexOf(selectorStart);
  assert.ok(i >= 0, `no rule starting with ${selectorStart}`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error('unbalanced braces');
}

describe('media/webview.css: the CSS contract (DESIGN 11)', () => {
  it('theme colour chains: user override -> contributed theme colour -> literal default', () => {
    assert.ok(css.includes('var(--fs-edited-override, var(--vscode-fileshake-editedforeground, #3fb950))'.toLowerCase()), 'edited chain');
    assert.ok(css.includes('var(--fs-referenced-override, var(--vscode-fileshake-referencedforeground, #e3b341))'.toLowerCase()), 'referenced chain');
  });

  it('@keyframes fs-shake has five steps and drives translate + rotate from the custom properties', () => {
    const kf = block('@keyframes fs-shake');
    const stops = kf.match(/(\d+(?:\.\d+)?%)\s*\{/g) ?? [];
    assert.ok(stops.length >= 5, `keyframe stops: ${stops.join(' ')}`);
    assert.ok(/translate\(calc\(var\(--fs-amp\) \*/.test(kf), 'translate uses --fs-amp');
    assert.ok(/rotate\(calc\(var\(--fs-rot\) \*/.test(kf), 'rotate uses --fs-rot');
  });

  it('.fs-row.is-shaking runs fs-shake for var(--fs-dur), linear, infinite', () => {
    const rule = block('.fs-row.is-shaking {');
    assert.match(rule, /animation:\s*fs-shake var\(--fs-dur\) linear infinite/);
  });

  it('prefers-reduced-motion: reduce forces animation: none !important', () => {
    const media = block('@media (prefers-reduced-motion: reduce)');
    assert.match(media, /animation:\s*none\s*!important/);
    assert.match(media, /\.is-shaking/);
  });

  it('#app[data-motion="off"] forces animation: none !important on rows', () => {
    assert.ok(css.includes('#app[data-motion="off"]'));
    const rule = block('#app[data-motion="off"] .fs-row');
    assert.match(rule, /animation:\s*none\s*!important/);
  });

  it('idle rows fade, leaving rows fade out over 400ms', () => {
    const idle = block('.fs-row.is-idle');
    assert.match(idle, /opacity:\s*\.55|opacity:\s*0\.55/);
    assert.match(idle, /transition:\s*opacity/);
    const leaving = block('.fs-row.is-leaving');
    assert.match(leaving, /opacity:\s*0\b/);
    assert.match(leaving, /transition:\s*opacity 400ms/);
  });

  it('the meter is the non-motion intensity cue: width = --fs-level * 100%', () => {
    const rule = block('.fs-meter > i');
    assert.match(rule, /width:\s*calc\(var\(--fs-level\) \* 100%\)/);
  });

  it('high-contrast themes get an outline on rows', () => {
    assert.ok(css.includes('body.vscode-high-contrast .fs-row'));
    assert.ok(css.includes('body.vscode-high-contrast-light .fs-row'));
    assert.ok(css.includes('outline: 1px solid var(--vscode-contrastborder)'));
  });

  it('colour is never the only cue: the row colour reaches the name, a 3px left border and the badge border', () => {
    assert.match(block('.fs-row {'), /border-left:\s*3px solid var\(--fs-row-color\)/);
    assert.match(block('.fs-name {'), /color:\s*var\(--fs-row-color\)/);
    const badge = block('.fs-badge {');
    assert.match(badge, /border:\s*1px solid var\(--fs-row-color\)/);
    assert.match(badge, /color:\s*var\(--fs-row-color\)/);
  });

  it('uses theme variables for fonts and background (light, dark and HC all follow the workbench)', () => {
    assert.ok(css.includes('var(--vscode-font-family'));
    assert.ok(css.includes('var(--vscode-foreground'));
  });

  it('no remote resources of any kind: no @import, no http(s):, no protocol-relative URLs, no external url()', () => {
    assert.ok(!/@import/.test(css));
    assert.ok(!/https?:/.test(css));
    assert.ok(!/url\(\s*['"]?\/\//.test(css));
    const urls = css.match(/url\(([^)]*)\)/g) ?? [];
    for (const u of urls) assert.ok(/data:|#/.test(u), `unexpected url(): ${u}`);
  });

  it('does not use unsupported-in-webview constructs that break strict CSP (no expression(), no behavior, no -moz-binding)', () => {
    assert.ok(!/expression\(|behavior:|-moz-binding/.test(css));
  });

  it('braces are balanced', () => {
    assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length);
  });
});

describe('media/webview.css applied in the DOM (jsdom cascade)', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.close();
    h = undefined;
  });

  function mountWithCss(): Harness {
    const html = `<!doctype html><html><head><style>${raw}</style></head><body><div id="app"></div></body></html>`;
    return mount({ html });
  }

  it('collapsing a folder hides its children and expanding shows them again', () => {
    h = mountWithCss();
    h.sendRows([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })]);
    const folder = must(folderById(h.root, 'src'));
    const win = must(h.document.defaultView);
    const children = must(folder.querySelector(':scope > ul.fs-children'));
    assert.notEqual(win.getComputedStyle(children).display, 'none');
    click(must(folder.querySelector(':scope > button.fs-folder-toggle')));
    assert.equal(folder.getAttribute('aria-expanded'), 'false');
    assert.equal(win.getComputedStyle(children).display, 'none', 'collapsed children must actually be hidden');
    click(must(folder.querySelector(':scope > button.fs-folder-toggle')));
    assert.notEqual(win.getComputedStyle(children).display, 'none');
  });

  it('a collapsed folder keeps its count visible (the count is on the toggle, not inside the hidden list)', () => {
    h = mountWithCss();
    h.sendRows([viewRow('/ws/src/a.ts', { folderPath: ['src'], dir: 'src' })]);
    const folder = must(folderById(h.root, 'src'));
    click(must(folder.querySelector(':scope > button.fs-folder-toggle')));
    const count = must(folder.querySelector(':scope > button.fs-folder-toggle .fs-folder-count'));
    assert.notEqual(must(h.document.defaultView).getComputedStyle(count).display, 'none');
  });
});
