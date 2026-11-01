import type { Collector, ParseInput } from './util';

const REQUIRE = /(?<![\w.@$:])(require_relative|require|load)\b[ \t]*\(?[ \t]*(['"])/g;
const AUTOLOAD = /(?<![\w.@$:])autoload\b[ \t]*\(?[ \t]*:\w+[ \t]*,[ \t]*(['"])/g;

export function parseRuby(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  REQUIRE.lastIndex = 0;
  AUTOLOAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = REQUIRE.exec(masked)) !== null) {
    const q = m.index + m[0].length - 1;
    const spec = strings.get(q);
    if (spec === undefined || spec === '') continue;
    out.add(m.index, q + spec.length + 1, {
      specifier: spec,
      kind: 'require',
      relativeLevel: m[1] === 'require_relative' ? 1 : 0,
    });
  }
  while (!out.full && (m = AUTOLOAD.exec(masked)) !== null) {
    const q = m.index + m[0].length - 1;
    const spec = strings.get(q);
    if (spec === undefined || spec === '') continue;
    out.add(m.index, q + spec.length + 1, { specifier: spec, kind: 'require' });
  }
}
