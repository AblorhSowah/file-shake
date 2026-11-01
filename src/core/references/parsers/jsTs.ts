import type { ImportBinding } from '../../types';
import { Collector, isIdentChar, isIdentStart, isSpace, isWordAt, readIdent, skipWs } from './util';
import type { ParseInput } from './util';

const MAX_CLAUSE = 50_000;
const KEYWORDS_BEFORE_REQUIRE = new Set(['const', 'let', 'var']);

/** Reads `... from 'm'` after an `import` keyword without regex backtracking. */
function readClause(masked: string, from: number): { clause: string; quoteAt: number } | undefined {
  const n = masked.length;
  let j = from;
  while (j < n && j - from < MAX_CLAUSE) {
    j = skipWs(masked, j);
    const c = masked[j];
    if (c === undefined) return undefined;
    if (isIdentStart(c)) {
      const word = readIdent(masked, j);
      if (word === 'import') return undefined;
      if (word === 'from') {
        const q = skipWs(masked, j + 4);
        if (masked[q] === "'" || masked[q] === '"') return { clause: masked.slice(from, j), quoteAt: q };
      }
      j += word.length;
      continue;
    }
    if (c === '{' || c === '}' || c === ',' || c === '*') {
      j += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

const TOKEN = /[A-Za-z_$][\w$]*|[{},*]/g;

function tokens(clause: string): string[] {
  return clause.match(TOKEN) ?? [];
}

function isIdent(t: string | undefined): t is string {
  return t !== undefined && /^[A-Za-z_$]/.test(t);
}

function parseNamedItems(tok: string[], from: number): { bindings: ImportBinding[]; next: number } {
  const bindings: ImportBinding[] = [];
  let k = from; // after '{'
  let item: string[] = [];
  const flush = (): void => {
    let it = item;
    item = [];
    if (it.length >= 2 && it[0] === 'type' && !(it.length === 3 && it[1] === 'as')) it = it.slice(1);
    if (it.length === 1 && isIdent(it[0])) bindings.push({ local: it[0], imported: it[0] });
    else if (it.length === 3 && it[1] === 'as' && isIdent(it[0]) && isIdent(it[2])) {
      bindings.push({ local: it[2], imported: it[0] });
    }
  };
  while (k < tok.length && tok[k] !== '}') {
    if (tok[k] === ',') flush();
    else item.push(tok[k] as string);
    k += 1;
  }
  flush();
  return { bindings, next: k + 1 };
}

function parseImportClause(clause: string): { bindings: ImportBinding[]; typeOnly: boolean } {
  const tok = tokens(clause);
  let k = 0;
  let typeOnly = false;
  if (tok[0] === 'type' && tok.length > 1 && tok[1] !== ',') {
    typeOnly = true;
    k = 1;
  }
  const bindings: ImportBinding[] = [];
  if (isIdent(tok[k]) && tok[k] !== 'typeof') {
    bindings.push({ local: tok[k] as string, imported: 'default' });
    k += 1;
    if (tok[k] === ',') k += 1;
  }
  if (tok[k] === '*') {
    if (tok[k + 1] === 'as' && isIdent(tok[k + 2])) bindings.push({ local: tok[k + 2] as string, imported: '*' });
  } else if (tok[k] === '{') {
    bindings.push(...parseNamedItems(tok, k + 1).bindings);
  }
  return { bindings, typeOnly };
}

/** Bindings for `const|let|var X = require('m')` / `const { a, b: c } = require('m')`, looking backwards. */
function requireBindings(masked: string, requireAt: number): { bindings: ImportBinding[]; start: number } {
  const none = { bindings: [] as ImportBinding[], start: requireAt };
  const back = (from: number): number => {
    let j = from;
    while (j >= 0 && isSpace(masked[j])) j -= 1;
    return j;
  };
  let j = back(requireAt - 1);
  if (masked[j] !== '=' || masked[j - 1] === '=' || masked[j - 1] === '!' || masked[j - 1] === '>' || masked[j - 1] === '<') {
    return none;
  }
  j = back(j - 1);
  const c = masked[j];
  let bindings: ImportBinding[] = [];
  if (c !== undefined && isIdentChar(c)) {
    let s = j;
    while (s > 0 && isIdentChar(masked[s - 1])) s -= 1;
    const local = masked.slice(s, j + 1);
    if (!isIdentStart(local[0])) return none;
    bindings = [{ local, imported: '*' }];
    j = s - 1;
  } else if (c === '}') {
    const lim = Math.max(0, j - 2000);
    let s = j - 1;
    while (s >= lim && masked[s] !== '{' && masked[s] !== '}') s -= 1;
    if (s < lim || masked[s] !== '{') return none;
    const inner = masked.slice(s + 1, j);
    for (const raw of inner.split(',')) {
      const part = raw.trim();
      if (part === '' || part.startsWith('...')) continue;
      const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=.*)?$/s.exec(part);
      if (m && m[1] !== undefined) bindings.push({ local: m[2] ?? m[1], imported: m[1] });
    }
    j = s - 1;
  } else return none;
  j = back(j);
  let s = j;
  while (s > 0 && isIdentChar(masked[s - 1])) s -= 1;
  const kw = masked.slice(s, j + 1);
  return KEYWORDS_BEFORE_REQUIRE.has(kw) ? { bindings, start: s } : none;
}

const IMPORT_EQ = /[ \t\r\n]+(?:type[ \t\r\n]+)?([A-Za-z_$][\w$]*)[ \t\r\n]*=[ \t\r\n]*require[ \t\r\n]*\([ \t\r\n]*(['"])/y;

export function parseJsTs(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  const consumed = new Set<number>();

  const specAt = (q: number, allowTemplate: boolean): string | undefined => {
    const ch = masked[q];
    if (ch !== "'" && ch !== '"' && !(allowTemplate && ch === '`')) return undefined;
    const raw = strings.get(q);
    if (raw === undefined || raw.includes('${')) return undefined;
    return raw;
  };

  // --- import ---------------------------------------------------------------
  const IMPORT = /import/g;
  let m: RegExpExecArray | null;
  while (!out.full && (m = IMPORT.exec(masked)) !== null) {
    const start = m.index;
    if (!isWordAt(masked, start, 6)) continue;
    let p = start - 1;
    while (p >= 0 && (masked[p] === ' ' || masked[p] === '\t')) p -= 1;
    if (masked[p] === '.') continue; // foo.import(...)
    const j = skipWs(masked, start + 6);
    const c = masked[j];
    if (c === '(') {
      const k = skipWs(masked, j + 1);
      const spec = specAt(k, true);
      if (spec !== undefined) {
        consumed.add(k);
        out.add(start, k + 1 + spec.length, { specifier: spec, kind: 'dynamic' });
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const spec = specAt(j, false);
      if (spec !== undefined) {
        consumed.add(j);
        out.add(start, j + 1 + spec.length, { specifier: spec, kind: 'import' });
      }
      continue;
    }
    if (c === '.') continue; // import.meta
    IMPORT_EQ.lastIndex = start + 6;
    const eq = IMPORT_EQ.exec(masked);
    if (eq && eq[1] !== undefined) {
      const q = IMPORT_EQ.lastIndex - 1;
      const spec = specAt(q, false);
      if (spec !== undefined) {
        consumed.add(q);
        out.add(start, q + 1 + spec.length, {
          specifier: spec,
          kind: 'import',
          bindings: [{ local: eq[1], imported: '*' }],
        });
      }
      continue;
    }
    const clause = readClause(masked, start + 6);
    if (!clause) continue;
    const spec = specAt(clause.quoteAt, false);
    if (spec === undefined) continue;
    consumed.add(clause.quoteAt);
    const parsed = parseImportClause(clause.clause);
    out.add(start, clause.quoteAt + 1 + spec.length, {
      specifier: spec,
      kind: 'import',
      bindings: parsed.bindings,
      typeOnly: parsed.typeOnly,
    });
  }

  // --- export ... from --------------------------------------------------------
  const EXPORT = /export/g;
  while (!out.full && (m = EXPORT.exec(masked)) !== null) {
    const start = m.index;
    if (!isWordAt(masked, start, 6)) continue;
    let j = skipWs(masked, start + 6);
    let typeOnly = false;
    if (masked.startsWith('type', j) && isSpace(masked[j + 4]) ) {
      const after = skipWs(masked, j + 4);
      if (masked[after] === '{' || masked[after] === '*') {
        typeOnly = true;
        j = after;
      }
    }
    if (masked[j] === '*') {
      j = skipWs(masked, j + 1);
      if (masked.startsWith('as', j) && isSpace(masked[j + 2])) {
        j = skipWs(masked, j + 2);
        j += readIdent(masked, j).length;
        j = skipWs(masked, j);
      }
    } else if (masked[j] === '{') {
      const close = masked.indexOf('}', j + 1);
      if (close === -1 || close - j > MAX_CLAUSE) continue;
      const open2 = masked.indexOf('{', j + 1);
      if (open2 !== -1 && open2 < close) continue;
      j = skipWs(masked, close + 1);
    } else continue;
    if (!masked.startsWith('from', j) || isIdentChar(masked[j + 4])) continue;
    const q = skipWs(masked, j + 4);
    const spec = specAt(q, false);
    if (spec === undefined) continue;
    consumed.add(q);
    out.add(start, q + 1 + spec.length, { specifier: spec, kind: 'export-from', typeOnly });
  }

  // --- require ----------------------------------------------------------------
  const REQUIRE = /require/g;
  while (!out.full && (m = REQUIRE.exec(masked)) !== null) {
    const start = m.index;
    if (!isWordAt(masked, start, 7)) continue;
    let p = start - 1;
    while (p >= 0 && (masked[p] === ' ' || masked[p] === '\t')) p -= 1;
    if (masked[p] === '.') continue;
    const open = skipWs(masked, start + 7);
    if (masked[open] !== '(') continue;
    const q = skipWs(masked, open + 1);
    if (consumed.has(q)) continue;
    const spec = specAt(q, false);
    if (spec === undefined) continue;
    const endQuote = q + 1 + spec.length;
    const after = skipWs(masked, endQuote + 1);
    let decl: { bindings: ImportBinding[]; start: number } = { bindings: [], start };
    const nextCh = masked[masked[after] === ')' ? skipWs(masked, after + 1) : after];
    if (nextCh !== '.' && nextCh !== '(' && nextCh !== '[') decl = requireBindings(masked, start);
    out.add(decl.start, endQuote, { specifier: spec, kind: 'require', bindings: decl.bindings });
  }
}
