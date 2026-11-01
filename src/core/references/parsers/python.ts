import type { ImportBinding } from '../../types';
import type { Collector, ParseInput } from './util';

const MAX_STATEMENT = 20_000;
const KEYWORD = /(^|[;:])[ \t]*(import|from)\b/gm;
const DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const NAME = /^[A-Za-z_]\w*$/;

/** Reads the rest of a logical line: honours (), [], {} nesting, backslash continuations and ';'. */
function readLogical(masked: string, from: number): { text: string; end: number } {
  const n = masked.length;
  let depth = 0;
  let j = from;
  while (j < n && j - from < MAX_STATEMENT) {
    const c = masked[j];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '\\' && (masked[j + 1] === '\n' || masked[j + 1] === '\r')) {
      j += masked[j + 1] === '\r' && masked[j + 2] === '\n' ? 3 : 2;
      continue;
    } else if (c === '\n' && depth === 0) break;
    else if (c === ';' && depth === 0) break;
    j += 1;
  }
  return { text: masked.slice(from, j).replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim(), end: j };
}

function parseNames(list: string): ImportBinding[] | undefined {
  let t = list.trim();
  if (t.startsWith('(')) t = t.slice(1);
  if (t.endsWith(')')) t = t.slice(0, -1);
  t = t.trim();
  if (t === '*') return [];
  const bindings: ImportBinding[] = [];
  for (const raw of t.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const bits = part.split(' ');
    if (bits.length === 1 && bits[0] !== undefined && NAME.test(bits[0])) {
      bindings.push({ local: bits[0], imported: bits[0] });
    } else if (bits.length === 3 && bits[1] === 'as' && NAME.test(bits[0] ?? '') && NAME.test(bits[2] ?? '')) {
      bindings.push({ local: bits[2] as string, imported: bits[0] as string });
    } else return undefined;
  }
  return bindings;
}

export function parsePython(inp: ParseInput, out: Collector): void {
  const { masked } = inp;
  KEYWORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = KEYWORD.exec(masked)) !== null) {
    const kw = m[2] as string;
    const kwStart = m.index + m[0].length - kw.length;
    const { text, end } = readLogical(masked, m.index + m[0].length);
    KEYWORD.lastIndex = Math.max(KEYWORD.lastIndex, end);
    if (kw === 'import') {
      for (const raw of text.split(',')) {
        const part = raw.trim();
        const bits = part.split(' ');
        if (bits.length === 1 && bits[0] !== undefined && DOTTED.test(bits[0])) {
          out.add(kwStart, end - 1, {
            specifier: bits[0],
            kind: 'import',
            bindings: [{ local: bits[0], imported: '*' }],
          });
        } else if (bits.length === 3 && bits[1] === 'as' && DOTTED.test(bits[0] ?? '') && NAME.test(bits[2] ?? '')) {
          out.add(kwStart, end - 1, {
            specifier: bits[0] as string,
            kind: 'import',
            bindings: [{ local: bits[2] as string, imported: '*' }],
          });
        }
      }
      continue;
    }
    // from [dots][module] import names
    const dotsMatch = /^\.*/.exec(text);
    const dots = dotsMatch ? dotsMatch[0].length : 0;
    let rest = text.slice(dots).trimStart();
    let module = '';
    if (!(dots > 0 && /^import(?:\s|\(|$)/.test(rest))) {
      const mod = /^[A-Za-z_][\w.]*/.exec(rest);
      if (!mod) continue;
      module = mod[0];
      rest = rest.slice(module.length).trimStart();
    }
    if (!/^import(?:\s|\(|$)/.test(rest)) continue;
    const bindings = parseNames(rest.slice(6));
    if (bindings === undefined) continue;
    if (module.endsWith('.')) continue;
    out.add(kwStart, end - 1, { specifier: module, kind: 'import', bindings, relativeLevel: dots });
  }
}
