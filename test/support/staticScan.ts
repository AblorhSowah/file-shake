import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { REPO_ROOT } from './fixtures';

export function listTsFiles(dir: string): string[] {
  const abs = resolve(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) out.push(full);
    }
  };
  walk(abs);
  return out.sort();
}

export function rel(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

export function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Blanks comments (and optionally string / template contents) of TS source, keeping offsets and
 * newlines. A small state machine, good enough for policy checks (it does not model regex literals).
 */
export function strip(src: string, opts: { strings: boolean }): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const templateDepth: number[] = [];
  let braceDepth = 0;
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (opts.strings) blank(i + 1, j);
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      const start = j;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$' && src[j + 1] === '{') break;
        else j++;
      }
      if (opts.strings) blank(start, j);
      if (src[j] === '$' && src[j + 1] === '{') {
        templateDepth.push(braceDepth);
        braceDepth++;
        i = j + 2;
      } else {
        i = j + 1;
      }
    } else if (c === '{') {
      braceDepth++;
      i++;
    } else if (c === '}') {
      braceDepth--;
      if (templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braceDepth) {
        templateDepth.pop();
        // resume the template literal text after the closing brace
        let j = i + 1;
        const start = j;
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\') j += 2;
          else if (src[j] === '$' && src[j + 1] === '{') break;
          else j++;
        }
        if (opts.strings) blank(start, j);
        if (src[j] === '$' && src[j + 1] === '{') {
          templateDepth.push(braceDepth);
          braceDepth++;
          i = j + 2;
        } else {
          i = j + 1;
        }
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

export interface ImportRef {
  spec: string;
  typeOnly: boolean;
}

/** Module specifiers imported (statically or dynamically) by a TS file. */
export function importsOf(src: string): ImportRef[] {
  const code = strip(src, { strings: false });
  const refs: ImportRef[] = [];
  const re = /\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    refs.push({ spec: (m[2] ?? m[3] ?? m[4]) as string, typeOnly: m[1] !== undefined });
  }
  return refs;
}

/** Resolve a relative import to a .ts file path, or undefined. */
export function resolveLocal(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return undefined;
}

/** All files reachable through RUNTIME (non type-only) relative imports, plus the external specifiers met. */
export function runtimeClosure(entry: string): { files: string[]; externals: Array<{ from: string; spec: string }> } {
  const seen = new Set<string>();
  const externals: Array<{ from: string; spec: string }> = [];
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const imp of importsOf(read(f))) {
      if (imp.typeOnly) continue;
      const local = resolveLocal(f, imp.spec);
      if (local) stack.push(local);
      else if (!imp.spec.startsWith('.')) externals.push({ from: f, spec: imp.spec });
    }
  }
  return { files: [...seen].sort(), externals };
}
