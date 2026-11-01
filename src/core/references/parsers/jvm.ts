import type { Collector, ParseInput } from './util';
import { lastSegment } from './util';

const IMPORT = /^[ \t]*import[ \t]+(static[ \t]+)?([A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*(?:[A-Za-z_$][\w$]*|\*))*)(?:[ \t]+as[ \t]+([A-Za-z_$][\w$]*))?/gm;
const PACKAGE = /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][\w$]*)*)/m;

/** The `package a.b.c` declaration of a Java/Kotlin file, if any. */
export function readPackageName(masked: string): string | undefined {
  const m = PACKAGE.exec(masked);
  return m && m[1] !== undefined ? m[1].replace(/\s+/g, '') : undefined;
}

export function parseJvm(inp: ParseInput, out: Collector): void {
  const { masked } = inp;
  IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (!out.full && (m = IMPORT.exec(masked)) !== null) {
    const isStatic = m[1] !== undefined;
    const name = (m[2] as string).replace(/\s+/g, '');
    const alias = m[3];
    const start = m.index + m[0].indexOf('import');
    const bindings = name.endsWith('*')
      ? []
      : [{ local: alias ?? lastSegment(name, '.'), imported: lastSegment(name, '.') }];
    out.add(start, m.index + m[0].length - 1, { specifier: name, kind: 'import', bindings, isStatic });
  }
}
