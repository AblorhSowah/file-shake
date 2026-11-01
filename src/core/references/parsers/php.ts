import type { Collector, ParseInput } from './util';
import { lastSegment } from './util';

const INCLUDE =
  /(?<![\w$>:])(require_once|require|include_once|include)\b[ \t]*\(?[ \t]*(?:(__DIR__|dirname[ \t]*\([ \t]*__FILE__[ \t]*\))[ \t]*\.[ \t]*)?(['"])/g;
const USE = /^[ \t]*use[ \t]+(?!function\b|const\b)(?=[\\A-Za-z_])/gm;
const MAX_USE = 20_000;
const NAME = /^\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*$/;

/** Splits on top-level commas (outside `{}`). */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function parseUseItem(item: string): Array<{ fqn: string; alias: string | undefined }> {
  const t = item.trim();
  if (t === '') return [];
  const group = /^(\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)\\\{(.*)\}$/s.exec(t);
  if (group && group[1] !== undefined && group[2] !== undefined) {
    const out: Array<{ fqn: string; alias: string | undefined }> = [];
    for (const sub of group[2].split(',')) {
      const s = sub.trim();
      if (s === '' || /^(?:function|const)\s/.test(s)) continue;
      for (const e of parseUseItem(s)) out.push({ fqn: `${group[1]}\\${e.fqn}`, alias: e.alias });
    }
    return out;
  }
  const m = /^(\S+)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(t);
  if (!m || m[1] === undefined || !NAME.test(m[1])) return [];
  return [{ fqn: m[1], alias: m[2] }];
}

export function parsePhp(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  INCLUDE.lastIndex = 0;
  USE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = INCLUDE.exec(masked)) !== null) {
    const q = m.index + m[0].length - 1;
    const spec = strings.get(q);
    if (spec === undefined || spec === '') continue;
    out.add(m.index, q + spec.length + 1, {
      specifier: spec,
      kind: 'include',
      relativeLevel: m[2] !== undefined ? 1 : 0,
    });
  }
  while (!out.full && (m = USE.exec(masked)) !== null) {
    const start = m.index + m[0].indexOf('use');
    const bodyStart = m.index + m[0].length;
    const semi = masked.indexOf(';', bodyStart);
    if (semi === -1 || semi - bodyStart > MAX_USE) continue;
    USE.lastIndex = Math.max(USE.lastIndex, semi);
    let body = masked.slice(bodyStart, semi).replace(/\s+/g, ' ');
    const brace = body.search(/(?<!\\)\{/);
    if (brace !== -1) body = body.slice(0, brace);
    for (const part of splitTop(body)) {
      for (const it of parseUseItem(part)) {
        const fqn = it.fqn.replace(/^\\/, '');
        const last = lastSegment(fqn, '\\');
        out.add(start, semi, {
          specifier: fqn,
          kind: 'use',
          bindings: [{ local: it.alias ?? last, imported: last }],
        });
      }
    }
  }
}
