import type { ImportBinding } from '../../types';
import type { Collector, ParseInput } from './util';
import { readIdent } from './util';

const ITEM = /^[ \t]*(?:pub(?:[ \t]*\([^)\n]*\))?[ \t]+)?(mod|use)[ \t]+/gm;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|::|[{},*]/g;
const MAX_USE = 20_000;

interface Emit {
  (spec: string[], bindings: ImportBinding[]): void;
}

/** Recursive-descent parse of a `use` tree; flat leaves of one group share one statement. */
function parseUse(tok: string[], emit: Emit): void {
  let k = 0;
  const isId = (t: string | undefined): t is string => t !== undefined && /^[A-Za-z_]/.test(t);

  const chain = (): string[] => {
    const segs: string[] = [];
    if (tok[k] === '::') k += 1;
    while (isId(tok[k])) {
      segs.push(tok[k] as string);
      k += 1;
      if (tok[k] === '::' && (isId(tok[k + 1]) || tok[k + 1] === '{' || tok[k + 1] === '*')) k += 1;
      else break;
    }
    return segs;
  };

  const alias = (): string | undefined => {
    if (tok[k] === 'as' && isId(tok[k + 1])) {
      const a = tok[k + 1] as string;
      k += 2;
      return a;
    }
    return undefined;
  };

  // parses one tree rooted at `prefix`; returns a leaf binding for flat items or undefined
  const tree = (prefix: string[], inGroup: boolean): ImportBinding | 'glob' | 'group' | undefined => {
    const segs = chain();
    const full = [...prefix, ...segs];
    if (tok[k] === '{') {
      k += 1;
      group(full);
      return 'group';
    }
    if (tok[k] === '*') {
      k += 1;
      if (full.length > 0) emit(full, []);
      return 'glob';
    }
    if (segs.length === 0) return undefined;
    const leaf = segs[segs.length - 1] as string;
    const a = alias();
    if (inGroup && segs.length === 1) {
      if (leaf === 'self') {
        const parent = prefix[prefix.length - 1];
        return parent === undefined ? undefined : { local: a ?? parent, imported: parent };
      }
      return { local: a ?? leaf, imported: leaf };
    }
    emit(full, [{ local: a ?? leaf, imported: leaf }]);
    return 'group';
  };

  const group = (prefix: string[]): void => {
    const bindings: ImportBinding[] = [];
    let guard = 0;
    while (k < tok.length && tok[k] !== '}' && guard++ < 5000) {
      const r = tree(prefix, true);
      if (r !== undefined && typeof r === 'object') bindings.push(r);
      if (tok[k] === ',') k += 1;
      else if (tok[k] !== '}' && r === undefined) k += 1; // skip junk
    }
    if (tok[k] === '}') k += 1;
    if (prefix.length > 0 && bindings.length > 0) emit(prefix, bindings);
  };

  const r = tree([], false);
  void r;
}

export function parseRust(inp: ParseInput, out: Collector): void {
  const { masked } = inp;
  ITEM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = ITEM.exec(masked)) !== null) {
    const kw = m[1] as string;
    const start = m.index + m[0].indexOf(kw);
    const bodyStart = m.index + m[0].length;
    if (kw === 'mod') {
      const name = readIdent(masked, bodyStart);
      if (name === '') continue;
      let j = bodyStart + name.length;
      while (masked[j] === ' ' || masked[j] === '\t') j += 1;
      if (masked[j] === ';') out.add(start, j, { specifier: name, kind: 'mod' });
      continue;
    }
    const semi = masked.indexOf(';', bodyStart);
    if (semi === -1 || semi - bodyStart > MAX_USE) continue;
    const tok = masked.slice(bodyStart, semi).match(TOKEN) ?? [];
    ITEM.lastIndex = Math.max(ITEM.lastIndex, semi);
    parseUse(tok, (spec, bindings) => {
      out.add(start, semi, { specifier: spec.join('::'), kind: 'use', bindings });
    });
  }
}
