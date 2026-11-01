import type { Collector, ParseInput } from './util';

const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*(?:(")|<([^>\n]*)>)/gm;

export function parseCFamily(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  INCLUDE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = INCLUDE.exec(masked)) !== null) {
    const start = m.index + m[0].indexOf('#');
    if (m[1] !== undefined) {
      const q = m.index + m[0].length - 1;
      const spec = strings.get(q);
      if (spec === undefined || spec === '') continue;
      out.add(start, q + spec.length + 1, { specifier: spec, kind: 'include' });
    } else {
      const spec = (m[2] ?? '').trim();
      if (spec === '') continue;
      out.add(start, m.index + m[0].length - 1, { specifier: spec, kind: 'include', angle: true });
    }
  }
}
