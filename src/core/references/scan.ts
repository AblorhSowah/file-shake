import type { LanguageKey, ScanResult } from '../types';

export type { LanguageKey, ScanResult };

/** Replaces every character except line breaks with a space (length preserved). */
export function blankOf(s: string): string {
  return s.replace(/[^\r\n]/g, ' ');
}

/** Builds `masked` incrementally: only ranges that get blanked are copied. Calls must be in increasing order. */
class Masker {
  private readonly parts: string[] = [];
  private last = 0;

  constructor(private readonly text: string) {}

  blank(from: number, to: number): void {
    const end = Math.min(to, this.text.length);
    if (end <= from || from < this.last) return;
    if (from > this.last) this.parts.push(this.text.slice(this.last, from));
    this.parts.push(blankOf(this.text.slice(from, end)));
    this.last = end;
  }

  finish(): string {
    if (this.last < this.text.length) this.parts.push(this.text.slice(this.last));
    this.last = this.text.length;
    return this.parts.join('');
  }
}

/** Copy of `text` with the given [start, end] ranges (inclusive) blanked; line breaks are kept. */
export function blankSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  if (spans.length === 0) return text;
  const m = new Masker(text);
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let last = 0;
  for (const [start, end] of sorted) {
    const from = Math.max(start, last);
    if (end + 1 > from) {
      m.blank(from, end + 1);
      last = end + 1;
    }
  }
  return m.finish();
}

export interface LineIndex {
  /** 1-based line containing the offset */
  lineOf(offset: number): number;
  readonly lineCount: number;
}

export function buildLineIndex(text: string): LineIndex {
  const starts: number[] = [0];
  let p = text.indexOf('\n');
  while (p !== -1) {
    starts.push(p + 1);
    p = text.indexOf('\n', p + 1);
  }
  return {
    lineCount: starts.length,
    lineOf(offset: number): number {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const MAX_REGEX_LEN = 1000;
const REGEX_PREV = '(,=:[!&|?{};';

interface Quoted {
  /** index of the closing quote (or where scanning stopped) */
  contentEnd: number;
  /** index to continue from */
  next: number;
  closed: boolean;
}

function scanQuoted(text: string, start: number, quote: string, multiline: boolean): Quoted {
  const n = text.length;
  let j = start + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\') {
      j += text[j + 1] === '\r' && text[j + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (c === quote) return { contentEnd: j, next: j + 1, closed: true };
    if (!multiline && (c === '\n' || c === '\r')) return { contentEnd: j, next: j, closed: false };
    j += 1;
  }
  return { contentEnd: n, next: n, closed: false };
}

/** Finds the end of a triple-quoted string; `open` is the index of the first opening quote. */
function scanTriple(text: string, open: number, quote: string): Quoted {
  const n = text.length;
  const triple = quote + quote + quote;
  let j = open + 3;
  while (j < n) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote && text.startsWith(triple, j)) return { contentEnd: j, next: j + 3, closed: true };
    j += 1;
  }
  return { contentEnd: n, next: n, closed: false };
}

const PHP_OPEN = /<\?(?:php\b|=)/gi;

function scanCLike(lang: LanguageKey, text: string): ScanResult {
  const n = text.length;
  const m = new Masker(text);
  const strings = new Map<number, string>();
  const isJs = lang === 'ts' || lang === 'js';
  const isPhp = lang === 'php';
  const isRust = lang === 'rust';
  const isGo = lang === 'go';
  const isJvm = lang === 'java' || lang === 'kotlin';
  const lineComments = lang !== 'css';
  const multilineQuotes = isRust || isPhp;
  const templates: Array<{ depth: number; openAt: number }> = [];
  let braceDepth = 0;
  let inPhp = !isPhp;
  let i = 0;

  /** Scans template-literal text from `from` up to the closing backtick or the next `${`. Returns the next code index. */
  const templateText = (from: number, openAt: number): number => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        strings.set(openAt, text.slice(openAt + 1, j));
        m.blank(from, j);
        return j + 1;
      }
      if (c === '$' && text[j + 1] === '{') {
        m.blank(from, j);
        templates.push({ depth: braceDepth, openAt });
        braceDepth += 1;
        return j + 2;
      }
      j += 1;
    }
    m.blank(from, n);
    return n;
  };

  const lineEnd = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '\r') return j;
      if (isPhp && c === '?' && text[j + 1] === '>') return j;
      j += 1;
    }
    return n;
  };

  while (i < n) {
    if (!inPhp) {
      PHP_OPEN.lastIndex = i;
      const mt = PHP_OPEN.exec(text);
      const end = mt ? mt.index + mt[0].length : n;
      m.blank(i, end);
      i = end;
      inPhp = true;
      continue;
    }
    const c = text[i] as string;

    if (c === '/') {
      const c1 = text[i + 1];
      if (c1 === '/' && lineComments) {
        const end = lineEnd(i);
        m.blank(i, end);
        i = end;
        continue;
      }
      if (c1 === '*') {
        if (isRust) {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (text[j] === '/' && text[j + 1] === '*') {
              depth += 1;
              j += 2;
            } else if (text[j] === '*' && text[j + 1] === '/') {
              depth -= 1;
              j += 2;
            } else j += 1;
          }
          m.blank(i, j);
          i = j;
        } else {
          const close = text.indexOf('*/', i + 2);
          const end = close === -1 ? n : close + 2;
          m.blank(i, end);
          i = end;
        }
        continue;
      }
      if (isJs && regexAllowed(text, i)) {
        const end = scanRegex(text, i);
        if (end !== -1) {
          m.blank(i + 1, end);
          i = end + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (c === '#' && isPhp) {
      const end = lineEnd(i);
      m.blank(i, end);
      i = end;
      continue;
    }

    if (isPhp && c === '?' && text[i + 1] === '>') {
      m.blank(i, i + 2);
      i += 2;
      inPhp = false;
      continue;
    }

    if (c === '"' || c === "'") {
      if (c === '"' && isJvm && text.startsWith('"""', i)) {
        const r = scanTriple(text, i, '"');
        if (r.closed) strings.set(i, text.slice(i + 3, r.contentEnd));
        m.blank(i + 3, r.contentEnd);
        i = r.next;
        continue;
      }
      if (c === "'" && isRust) {
        const c1 = text[i + 1];
        let close = -1;
        if (c1 === '\\') {
          const lim = Math.min(n, i + 14);
          for (let j = i + 2; j < lim; j += 1) {
            if (text[j] === "'") {
              close = j;
              break;
            }
          }
        } else if (text[i + 2] === "'") close = i + 2;
        else if (text[i + 3] === "'" && c1 !== undefined && c1 >= '\ud800' && c1 <= '\udbff') close = i + 3;
        if (close === -1) {
          i += 1; // lifetime or label
          continue;
        }
        strings.set(i, text.slice(i + 1, close));
        m.blank(i + 1, close);
        i = close + 1;
        continue;
      }
      const r = scanQuoted(text, i, c, multilineQuotes);
      if (r.closed) strings.set(i, text.slice(i + 1, r.contentEnd));
      m.blank(i + 1, r.contentEnd);
      i = r.next;
      continue;
    }

    if (c === '`') {
      if (isJs) {
        i = templateText(i + 1, i);
        continue;
      }
      if (isGo) {
        const close = text.indexOf('`', i + 1);
        const end = close === -1 ? n : close;
        if (close !== -1) strings.set(i, text.slice(i + 1, end));
        m.blank(i + 1, end);
        i = close === -1 ? n : close + 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (isJs) {
      if (c === '{') {
        braceDepth += 1;
        i += 1;
        continue;
      }
      if (c === '}') {
        const top = templates[templates.length - 1];
        if (top && braceDepth - 1 === top.depth) {
          templates.pop();
          braceDepth = top.depth;
          i = templateText(i + 1, top.openAt);
        } else {
          braceDepth = Math.max(0, braceDepth - 1);
          i += 1;
        }
        continue;
      }
    }

    if (isRust && (c === 'r' || c === 'b')) {
      const prev = i > 0 ? (text[i - 1] as string) : '';
      if (!IDENT_CHAR.test(prev)) {
        let j = i;
        if (text[j] === 'b') j += 1;
        if (text[j] === 'r') {
          j += 1;
          let hashes = 0;
          while (text[j] === '#') {
            hashes += 1;
            j += 1;
          }
          if (text[j] === '"' && (j > i + 1 || text[i] === 'r')) {
            const closer = `"${'#'.repeat(hashes)}`;
            const close = text.indexOf(closer, j + 1);
            const end = close === -1 ? n : close;
            if (close !== -1) strings.set(j, text.slice(j + 1, end));
            m.blank(j + 1, end);
            i = close === -1 ? n : close + closer.length;
            continue;
          }
        }
      }
    }

    i += 1;
  }

  return { masked: m.finish(), strings };
}

/** Regex literals are recognised only after `( , = : [ ! & | ? { } ;` or at line start (best effort). */
function regexAllowed(text: string, slash: number): boolean {
  let j = slash - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  if (j < 0) return true;
  const p = text[j] as string;
  if (p === '\n' || p === '\r') return true;
  return REGEX_PREV.includes(p);
}

/** Returns the index of the closing slash, or -1 when this is not a regex literal. */
function scanRegex(text: string, start: number): number {
  const lim = Math.min(text.length, start + MAX_REGEX_LEN);
  let inClass = false;
  let j = start + 1;
  while (j < lim) {
    const c = text[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j > start + 1 ? j : -1;
    j += 1;
  }
  return -1;
}

function scanPython(text: string): ScanResult {
  const n = text.length;
  const m = new Masker(text);
  const strings = new Map<number, string>();
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '#') {
      let end = i;
      while (end < n && text[end] !== '\n' && text[end] !== '\r') end += 1;
      m.blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      if (text[i + 1] === c && text[i + 2] === c) {
        const r = scanTriple(text, i, c);
        if (r.closed) strings.set(i, text.slice(i + 3, r.contentEnd));
        m.blank(i + 3, r.contentEnd);
        i = r.next;
        continue;
      }
      const r = scanQuoted(text, i, c, false);
      if (r.closed) strings.set(i, text.slice(i + 1, r.contentEnd));
      m.blank(i + 1, r.contentEnd);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return { masked: m.finish(), strings };
}

function scanRuby(text: string): ScanResult {
  const n = text.length;
  const m = new Masker(text);
  const strings = new Map<number, string>();
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i] as string;
    if (lineStart && c === '=' && text.startsWith('=begin', i)) {
      const endMarker = /^=end\b[^\n]*/m;
      const rest = text.slice(i);
      const mt = endMarker.exec(rest.slice(6));
      const end = mt ? i + 6 + mt.index + mt[0].length : n;
      m.blank(i, end);
      i = end;
      lineStart = false;
      continue;
    }
    lineStart = c === '\n';
    if (c === '#') {
      let end = i;
      while (end < n && text[end] !== '\n' && text[end] !== '\r') end += 1;
      m.blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const r = scanQuoted(text, i, c, false);
      if (r.closed) strings.set(i, text.slice(i + 1, r.contentEnd));
      m.blank(i + 1, r.contentEnd);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return { masked: m.finish(), strings };
}

function scanHtml(text: string): ScanResult {
  const n = text.length;
  const m = new Masker(text);
  let i = text.indexOf('<!--');
  while (i !== -1 && i < n) {
    const close = text.indexOf('-->', i + 4);
    const end = close === -1 ? n : close + 3;
    m.blank(i, end);
    i = close === -1 ? -1 : text.indexOf('<!--', end);
  }
  return { masked: m.finish(), strings: new Map() };
}

const FENCE_OPEN = /[ ]{0,3}(`{3,}|~{3,})/y;
const MAX_INLINE_CODE_LOOKAHEAD = 1000;

/** Fenced code blocks, inline code and HTML comments are blanked; link syntax is kept. */
function scanMarkdown(text: string): ScanResult {
  const n = text.length;
  const m = new Masker(text);
  let i = 0;
  let atLineStart = true;
  let eol = -1;
  while (i < n) {
    if (i > eol) {
      eol = text.indexOf('\n', i);
      if (eol === -1) eol = n;
    }
    if (atLineStart) {
      atLineStart = false;
      FENCE_OPEN.lastIndex = i;
      const fence = FENCE_OPEN.exec(text);
      if (fence && fence[1] !== undefined) {
        const ch = fence[1][0] as string;
        const len = fence[1].length;
        let j = eol + 1;
        let end = n;
        while (j < n) {
          let e2 = text.indexOf('\n', j);
          if (e2 === -1) e2 = n;
          const t = text.slice(j, e2).replace(/\r$/, '').replace(/^ {0,3}/, '');
          let k = 0;
          while (t[k] === ch) k += 1;
          if (k >= len && t.slice(k).trim() === '') {
            end = e2;
            break;
          }
          j = e2 + 1;
        }
        m.blank(i, end);
        i = end;
        continue;
      }
    }
    const c = text[i];
    if (c === '\n') {
      atLineStart = true;
      i += 1;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run += 1;
      const closer = '`'.repeat(run);
      const limit = Math.min(eol, i + run + MAX_INLINE_CODE_LOOKAHEAD);
      let q = i + run;
      let found = -1;
      while (q < limit) {
        const idx = text.indexOf(closer, q);
        if (idx === -1 || idx >= limit) break;
        let rl = 0;
        while (text[idx + rl] === '`') rl += 1;
        if (rl === run) {
          found = idx;
          break;
        }
        q = idx + rl;
      }
      if (found !== -1) {
        m.blank(i, found + run);
        i = found + run;
      } else i += run;
      continue;
    }
    if (c === '<' && text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const end = close === -1 ? n : close + 3;
      m.blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return { masked: m.finish(), strings: new Map() };
}

/**
 * Masks comments and string contents (same length, newlines kept) so regex-based parsers never
 * match inside them. Never throws.
 */
export function scanCode(lang: LanguageKey, text: string): ScanResult {
  try {
    switch (lang) {
      case 'python':
        return scanPython(text);
      case 'ruby':
        return scanRuby(text);
      case 'html':
        return scanHtml(text);
      case 'markdown':
        return scanMarkdown(text);
      default:
        return scanCLike(lang, text);
    }
  } catch {
    return { masked: blankOf(text), strings: new Map() };
  }
}
