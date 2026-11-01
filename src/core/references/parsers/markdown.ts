import type { Collector, ParseInput } from './util';
import { cleanLocalUrl } from './html';

const INLINE = /\]\([ \t]*(?:<([^>\n]*)>|([^\s)]*))/g;
const REFDEF = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;

export function parseMarkdown(inp: ParseInput, out: Collector): void {
  const { masked } = inp;
  INLINE.lastIndex = 0;
  REFDEF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = INLINE.exec(masked)) !== null) {
    const path = cleanLocalUrl(m[1] ?? m[2] ?? '');
    if (path !== undefined) out.add(m.index, m.index + m[0].length - 1, { specifier: path, kind: 'markdown-link' });
  }
  while (!out.full && (m = REFDEF.exec(masked)) !== null) {
    const path = cleanLocalUrl(m[1] ?? m[2] ?? '');
    if (path !== undefined) out.add(m.index, m.index + m[0].length - 1, { specifier: path, kind: 'markdown-link' });
  }
}
