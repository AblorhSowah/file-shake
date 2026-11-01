import type { Collector, ParseInput } from './util';
import { isSpace } from './util';

const TAG = /<([A-Za-z][^\s/>]*)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DYNAMIC = /\{\{|\{%|<%|\$\{|<\?/;

/** Cleans an attribute/link value: undefined when it is not a local file reference. */
export function cleanLocalUrl(raw: string): string | undefined {
  const v = raw.trim();
  if (v === '' || SCHEME.test(v) || v.startsWith('//') || v.startsWith('#') || DYNAMIC.test(v)) return undefined;
  const cut = v.search(/[?#]/);
  const path = (cut === -1 ? v : v.slice(0, cut)).trim();
  return path === '' ? undefined : path;
}

export function parseHtml(inp: ParseInput, out: Collector): void {
  const { masked } = inp;
  const n = masked.length;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = TAG.exec(masked)) !== null) {
    const name = (m[1] as string).toLowerCase();
    let j = m.index + m[0].length;
    while (j < n) {
      while (j < n && isSpace(masked[j])) j += 1;
      const c = masked[j];
      if (c === undefined) break;
      if (c === '>') {
        j += 1;
        break;
      }
      if (c === '/') {
        j += 1;
        continue;
      }
      const attrStart = j;
      while (j < n && !isSpace(masked[j]) && masked[j] !== '=' && masked[j] !== '>' && masked[j] !== '/') j += 1;
      if (j === attrStart) {
        j += 1;
        continue;
      }
      const attr = masked.slice(attrStart, j).toLowerCase();
      while (j < n && isSpace(masked[j])) j += 1;
      if (masked[j] !== '=') continue;
      j += 1;
      while (j < n && isSpace(masked[j])) j += 1;
      const q = masked[j];
      let value: string;
      if (q === '"' || q === "'") {
        const close = masked.indexOf(q, j + 1);
        const end = close === -1 ? n : close;
        value = masked.slice(j + 1, end);
        j = close === -1 ? n : close + 1;
      } else {
        const vs = j;
        while (j < n && !isSpace(masked[j]) && masked[j] !== '>') j += 1;
        value = masked.slice(vs, j);
      }
      if (attr === 'src' || attr === 'href') {
        const path = cleanLocalUrl(value);
        if (path !== undefined) out.add(attrStart, j - 1, { specifier: path, kind: 'link' });
      }
    }
    TAG.lastIndex = j;
    if (name === 'script' || name === 'style') {
      const close = new RegExp(`</${name}`, 'ig');
      close.lastIndex = j;
      const cm = close.exec(masked);
      TAG.lastIndex = cm ? cm.index : n;
    }
  }
}
