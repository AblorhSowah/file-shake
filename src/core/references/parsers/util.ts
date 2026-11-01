import { K } from '../../constants';
import type { ImportBinding, ImportKind, ImportStatement, LanguageKey } from '../../types';
import type { LineIndex } from '../scan';

export interface ParseInput {
  lang: LanguageKey;
  text: string;
  masked: string;
  strings: ReadonlyMap<number, string>;
  lines: LineIndex;
}

export interface StatementInit {
  specifier: string;
  kind: ImportKind;
  bindings?: ImportBinding[];
  typeOnly?: boolean;
  relativeLevel?: number;
  angle?: boolean;
  isStatic?: boolean;
}

/** Collects statements, enforcing MAX_STATEMENTS and the specifier sanity limits (DESIGN 8.4). */
export class Collector {
  private readonly items: Array<{ offset: number; end: number; stmt: ImportStatement }> = [];

  constructor(private readonly lines: LineIndex) {}

  get full(): boolean {
    return this.items.length >= K.MAX_STATEMENTS;
  }

  /** `start`/`end` are offsets into the text (end inclusive of the last character of the statement). */
  add(start: number, end: number, init: StatementInit): boolean {
    if (this.full) return false;
    const s = init.specifier;
    if (s.length > 512 || s.includes('\u0000') || s.includes('\n') || s.includes('\r')) return false;
    this.items.push({
      offset: start,
      end: Math.max(start, end),
      stmt: {
        specifier: s,
        kind: init.kind,
        line: this.lines.lineOf(start),
        endLine: this.lines.lineOf(Math.max(start, end)),
        bindings: init.bindings ?? [],
        typeOnly: init.typeOnly ?? false,
        relativeLevel: init.relativeLevel ?? 0,
        angle: init.angle ?? false,
        isStatic: init.isStatic ?? false,
      },
    });
    return true;
  }

  private sorted(): Array<{ offset: number; end: number; stmt: ImportStatement }> {
    return this.items
      .map((it, idx) => ({ ...it, idx }))
      .sort((a, b) => a.offset - b.offset || a.idx - b.idx);
  }

  result(): ImportStatement[] {
    return this.sorted().map((it) => it.stmt);
  }

  /** Source offsets [start, end] of each statement, in the same order as result(). */
  spans(): Array<[number, number]> {
    return this.sorted().map((it) => [it.offset, it.end]);
  }
}

export function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && c !== '' && /[A-Za-z_$]/.test(c);
}

export function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && c !== '' && /[A-Za-z0-9_$]/.test(c);
}

export function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

export function skipWs(s: string, from: number): number {
  let j = from;
  while (j < s.length && isSpace(s[j])) j += 1;
  return j;
}

/** Reads an identifier starting at `from`; returns '' when there is none. */
export function readIdent(s: string, from: number): string {
  if (!isIdentStart(s[from])) return '';
  let j = from + 1;
  while (j < s.length && isIdentChar(s[j])) j += 1;
  return s.slice(from, j);
}

/** True when `word` occurs at `idx` with identifier boundaries on both sides. */
export function isWordAt(s: string, idx: number, len: number): boolean {
  return !isIdentChar(s[idx - 1]) && !isIdentChar(s[idx + len]);
}

export function lastSegment(spec: string, sep: string): string {
  const idx = spec.lastIndexOf(sep);
  return idx === -1 ? spec : spec.slice(idx + sep.length);
}
