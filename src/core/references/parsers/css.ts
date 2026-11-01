import type { Collector, ParseInput } from './util';
import { isSpace } from './util';

const AT = /@(import|use|forward)\b/g;
const MAX_BODY = 2000;
const SKIP = /^(?:[a-z][a-z0-9+.-]*:|\/\/|~)/i;

export function parseCss(inp: ParseInput, out: Collector): void {
  const { masked, strings } = inp;
  const n = masked.length;
  AT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = AT.exec(masked)) !== null) {
    const kind = m[1] as string;
    const start = m.index;
    let j = m.index + m[0].length;
    const limit = Math.min(n, j + MAX_BODY);
    let found = 0;
    const specs: Array<{ spec: string; end: number }> = [];
    while (j < limit) {
      const c = masked[j];
      if (c === ';' || c === '{' || c === '}') break;
      if (c === '"' || c === "'") {
        const spec = strings.get(j);
        if (spec === undefined) break;
        specs.push({ spec, end: j + spec.length + 1 });
        j += spec.length + 2;
        found += 1;
      } else if (c === 'u' && masked.startsWith('url(', j)) {
        let k = j + 4;
        while (k < limit && isSpace(masked[k])) k += 1;
        const q = masked[k];
        if (q === '"' || q === "'") {
          // quoted url(): the quote branch above reads the string next iteration
          j = k;
          continue;
        }
        const close = masked.indexOf(')', k);
        if (close === -1 || close > limit) break;
        specs.push({ spec: masked.slice(k, close).trim(), end: close });
        j = close + 1;
        found += 1;
      } else j += 1;
      if (found > 0 && kind !== 'import') break;
    }
    AT.lastIndex = Math.max(AT.lastIndex, j);
    for (const s of specs) {
      if (s.spec === '' || SKIP.test(s.spec)) continue;
      out.add(start, s.end, { specifier: s.spec, kind: 'style-import' });
    }
  }
}
