import type { Collector, ParseInput } from './util';
import { isIdentChar, isIdentStart, isSpace, readIdent } from './util';

const IMPORT = /^[ \t]*import\b/gm;

/** Package name Go code uses for an import path: last segment, skipping a trailing /vN or .vN. */
export function goLocalName(path: string): string {
  const segs = path.split('/').filter((s) => s !== '');
  let last = segs[segs.length - 1] ?? '';
  if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2] as string;
  last = last.replace(/\.v\d+$/, '');
  return last.replace(/^go-/, '').replace(/-go$/, '');
}

export function parseGo(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  const n = masked.length;

  const skip = (from: number, newlines: boolean): number => {
    let j = from;
    while (j < n && (newlines ? isSpace(masked[j]) || masked[j] === ';' : masked[j] === ' ' || masked[j] === '\t')) j += 1;
    return j;
  };

  /** Parses one import spec starting at `from`; returns the next index or -1. */
  const spec = (from: number, kwStart: number): number => {
    let j = skip(from, false);
    let alias = '';
    if (isIdentStart(masked[j]) || masked[j] === '.') {
      alias = masked[j] === '.' ? '.' : readIdent(masked, j);
      j = skip(j + alias.length, false);
    }
    const q = masked[j];
    if (q !== '"' && q !== '`') return -1;
    const path = strings.get(j);
    if (path === undefined) return -1;
    const local = alias === '' ? goLocalName(path) : alias;
    const bindings = local === '_' || local === '.' || local === '' ? [] : [{ local, imported: '*' }];
    out.add(kwStart === -1 ? j : kwStart, j + path.length + 1, { specifier: path, kind: 'import', bindings });
    return j + path.length + 2;
  };

  IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = IMPORT.exec(masked)) !== null) {
    const kw = m.index + m[0].length - 6;
    let j = skip(m.index + m[0].length, false);
    if (masked[j] === '(') {
      j += 1;
      for (;;) {
        j = skip(j, true);
        if (j >= n || masked[j] === ')') break;
        if (!(isIdentStart(masked[j]) || masked[j] === '.' || masked[j] === '"' || masked[j] === '`')) break;
        const next = spec(j, j);
        if (next === -1) break;
        j = next;
        if (out.full) break;
      }
      IMPORT.lastIndex = Math.max(IMPORT.lastIndex, j);
    } else if (isIdentChar(masked[j]) || masked[j] === '.' || masked[j] === '"' || masked[j] === '`') {
      const next = spec(j, kw);
      if (next !== -1) IMPORT.lastIndex = Math.max(IMPORT.lastIndex, next);
    }
  }
}
