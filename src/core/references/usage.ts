import type { ImportBinding } from '../types';
import { buildLineIndex } from './scan';

const IDENT_BEFORE = /[A-Za-z0-9_$]/;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Whether an occurrence at [idx, idx+len) has valid identifier boundaries in `masked`. */
function boundariesOk(masked: string, idx: number, len: number): boolean {
  const prev = idx > 0 ? (masked[idx - 1] as string) : '';
  const next = idx + len < masked.length ? (masked[idx + len] as string) : '';
  if (prev !== '' && IDENT_BEFORE.test(prev)) return false;
  if (next !== '' && IDENT_BEFORE.test(next)) return false;
  if (prev === '.') {
    // a single '.' means member access; '...' / '..' ranges and '?.' are allowed (DESIGN 8.2)
    const p2 = idx > 1 ? masked[idx - 2] : '';
    if (p2 !== '.' && p2 !== '?') return false;
  }
  return true;
}

/**
 * Counts whole-identifier usages of the bindings' local names in `masked`, ignoring the lines in
 * `excludeLines` (the import statements themselves). Locals are deduplicated.
 */
export function countUsages(
  masked: string,
  bindings: readonly ImportBinding[],
  excludeLines: ReadonlySet<number>,
): number {
  const simple = new Set<string>();
  const dotted = new Set<string>();
  for (const b of bindings) {
    if (b.local === '') continue;
    if (b.local.includes('.')) dotted.add(b.local);
    else simple.add(b.local);
  }
  if (simple.size === 0 && dotted.size === 0) return 0;

  const lines = excludeLines.size > 0 ? buildLineIndex(masked) : undefined;
  const excluded = (offset: number): boolean => lines !== undefined && excludeLines.has(lines.lineOf(offset));
  let total = 0;

  if (simple.size > 0) {
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(masked)) !== null) {
      const word = m[0];
      if (!simple.has(word)) continue;
      if (boundariesOk(masked, m.index, word.length) && !excluded(m.index)) total += 1;
    }
  }

  for (const local of dotted) {
    let from = 0;
    for (;;) {
      const idx = masked.indexOf(local, from);
      if (idx === -1) break;
      from = idx + local.length;
      if (boundariesOk(masked, idx, local.length) && !excluded(idx)) total += 1;
    }
  }
  return total;
}
