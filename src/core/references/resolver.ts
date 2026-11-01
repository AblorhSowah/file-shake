import { basename, dirname, extname, isUnder, joinPath, normalizePath } from '../pathUtils';
import type {
  FileKey,
  ImportBinding,
  ImportStatement,
  LanguageKey,
  ResolveContext,
  ResolvedTarget,
} from '../types';
import { readPackageName } from './parsers/jvm';
import { scanCode } from './scan';

// ---------------------------------------------------------------------------
// Probing: every fs access goes through the memo map and the shared probe budget.
// ---------------------------------------------------------------------------

const dirCache = new WeakMap<ResolveContext, Map<string, string[]>>();

async function probeFile(ctx: ResolveContext, p: FileKey): Promise<boolean> {
  const key = `f:${p}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit;
  if (ctx.budget.probes <= 0) return false;
  ctx.budget.probes -= 1;
  let ok: boolean;
  try {
    ok = await ctx.fs.isFile(p);
  } catch {
    ok = false;
  }
  ctx.memo.set(key, ok);
  return ok;
}

async function listDir(ctx: ResolveContext, p: FileKey): Promise<string[]> {
  let cache = dirCache.get(ctx);
  if (!cache) {
    cache = new Map();
    dirCache.set(ctx, cache);
  }
  const hit = cache.get(p);
  if (hit !== undefined) return hit;
  if (ctx.budget.probes <= 0) return [];
  ctx.budget.probes -= 1;
  let names: string[];
  try {
    names = await ctx.fs.listDir(p);
  } catch {
    names = [];
  }
  cache.set(p, names);
  ctx.memo.set(`d:${p}`, names.length > 0);
  return names;
}

/**
 * Cheap pre-filter: false only when the directory listing is non-empty and has no entry named
 * `name` (or `name.<ext>`). An empty/unknown listing never excludes anything.
 */
async function dirMayContain(ctx: ResolveContext, dir: FileKey, name: string): Promise<boolean> {
  const names = await listDir(ctx, dir);
  if (names.length === 0) return true;
  return names.some((n) => n === name || n.startsWith(`${name}.`));
}

async function firstExisting(ctx: ResolveContext, candidates: readonly FileKey[]): Promise<FileKey | undefined> {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await probeFile(ctx, c)) return c;
  }
  return undefined;
}

function one(key: FileKey | undefined, bindings: readonly ImportBinding[]): ResolvedTarget[] {
  return key === undefined ? [] : [{ key, bindings }];
}

/** All workspace roots, the one(s) containing `from` first (innermost first). */
function rootsFor(from: FileKey, ctx: ResolveContext): FileKey[] {
  const roots = ctx.project.roots.map(normalizePath);
  if (roots.length === 0) return [dirname(from)];
  const containing = roots.filter((r) => isUnder(r, from)).sort((a, b) => b.length - a.length);
  return [...containing, ...roots.filter((r) => !containing.includes(r))];
}

function innermostRoot(from: FileKey, ctx: ResolveContext): FileKey {
  let best: FileKey | undefined;
  for (const r of ctx.project.roots.map(normalizePath)) {
    if (isUnder(r, from) && (best === undefined || r.length > best.length)) best = r;
  }
  return best ?? dirname(from);
}

/** Directories from dirname(from) up to (and including) the innermost workspace root. */
function ancestorsToRoot(from: FileKey, ctx: ResolveContext): FileKey[] {
  const root = innermostRoot(from, ctx);
  const out: FileKey[] = [];
  let d = dirname(from);
  for (let i = 0; i < 64; i += 1) {
    out.push(d);
    if (d === root || dirname(d) === d || d === '') break;
    d = dirname(d);
  }
  return out;
}

function safeDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// TS / JS
// ---------------------------------------------------------------------------

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];

async function probeModule(ctx: ResolveContext, base: FileKey, exts: readonly string[]): Promise<FileKey | undefined> {
  const candidates: string[] = [];
  const ext = extname(base);
  if (ext !== '') candidates.push(base);
  if (/\.(?:js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.slice(0, base.length - ext.length);
    for (const e of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(stem + e);
  }
  for (const e of exts) candidates.push(base + e);
  for (const e of exts) candidates.push(`${base}/index${e}`);
  return firstExisting(ctx, candidates);
}

interface PathMatch {
  targets: string[];
}

function matchPaths(paths: Record<string, string[]>, spec: string): PathMatch | undefined {
  let best: { literal: number; targets: string[]; capture: string } | undefined;
  for (const [key, targets] of Object.entries(paths)) {
    const star = key.indexOf('*');
    let literal: number;
    let capture = '';
    if (star === -1) {
      if (key !== spec) continue;
      literal = Number.POSITIVE_INFINITY;
    } else {
      if (key.indexOf('*', star + 1) !== -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
      capture = spec.slice(prefix.length, spec.length - suffix.length);
      literal = prefix.length;
    }
    if (!best || literal > best.literal) best = { literal, targets, capture };
  }
  if (!best) return undefined;
  const capture = best.capture;
  return { targets: best.targets.map((t) => (t.includes('*') ? t.replace('*', capture) : t)) };
}

async function resolveJsLike(stmt: ImportStatement, from: FileKey, lang: LanguageKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const spec = normalizePath(stmt.specifier.replace(/\\/g, '/'));
  const raw = stmt.specifier.replace(/\\/g, '/');
  const exts = lang === 'ts' ? TS_EXTS : JS_EXTS;
  const bind = stmt.bindings;

  if (raw === '.' || raw === '..' || raw.startsWith('./') || raw.startsWith('../')) {
    return one(await probeModule(ctx, joinPath(dirname(from), raw), exts), bind);
  }
  if (raw.startsWith('/')) {
    for (const root of rootsFor(from, ctx)) {
      const hit = await probeModule(ctx, joinPath(root, raw.slice(1)), exts);
      if (hit) return one(hit, bind);
    }
    return [];
  }

  const ts = ctx.project.tsconfig;
  if (!ts) return [];
  const m = matchPaths(ts.paths, raw);
  if (m) {
    const baseDir = ts.baseUrl ?? ts.dir;
    for (const t of m.targets) {
      const hit = await probeModule(ctx, joinPath(baseDir, t), exts);
      if (hit) return one(hit, bind);
    }
  }
  if (ts.baseUrl !== undefined) {
    const first = spec.split('/')[0] ?? '';
    if (first !== '' && (await dirMayContain(ctx, ts.baseUrl, first))) {
      return one(await probeModule(ctx, joinPath(ts.baseUrl, raw), exts), bind);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

async function resolvePython(stmt: ImportStatement, from: FileKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const plain = stmt.bindings.length > 0 && stmt.bindings.every((b) => b.imported === '*');
  const parts = stmt.specifier === '' ? [] : stmt.specifier.split('.');

  const tryBase = async (base: FileKey): Promise<ResolvedTarget[]> => {
    const modPath = parts.length === 0 ? base : joinPath(base, parts.join('/'));
    let moduleFile: FileKey | undefined;
    if (parts.length === 0) {
      const init = joinPath(base, '__init__.py');
      moduleFile = (await probeFile(ctx, init)) ? init : undefined;
    } else {
      moduleFile = await firstExisting(ctx, [`${modPath}.py`, `${modPath}/__init__.py`]);
    }
    if (plain) return one(moduleFile, stmt.bindings);

    const out: ResolvedTarget[] = [];
    const rest: ImportBinding[] = [];
    const isPackage = moduleFile === undefined || basename(moduleFile) === '__init__.py';
    for (const b of stmt.bindings) {
      let sub: FileKey | undefined;
      if (isPackage && b.imported !== '*') {
        sub = await firstExisting(ctx, [`${modPath}/${b.imported}.py`, `${modPath}/${b.imported}/__init__.py`]);
      }
      if (sub !== undefined) out.push({ key: sub, bindings: [b] });
      else rest.push(b);
    }
    if (moduleFile !== undefined && (rest.length > 0 || stmt.bindings.length === 0)) {
      out.push({ key: moduleFile, bindings: rest });
    }
    return out;
  };

  if (stmt.relativeLevel > 0) {
    let base = dirname(from);
    for (let i = 1; i < stmt.relativeLevel; i += 1) base = dirname(base);
    return tryBase(base);
  }

  const searchRoots = ancestorsToRoot(from, ctx);
  const root = innermostRoot(from, ctx);
  const src = joinPath(root, 'src');
  if (!searchRoots.includes(src)) searchRoots.push(src);
  const first = parts[0] ?? '';
  for (const r of searchRoots) {
    if (first !== '' && !(await dirMayContain(ctx, r, first))) continue;
    const res = await tryBase(r);
    if (res.length > 0) return res;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

async function resolveGo(stmt: ImportStatement, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const mod = ctx.project.goModule;
  if (!mod) return [];
  const spec = stmt.specifier;
  let rest: string;
  if (spec === mod.modulePath) rest = '';
  else if (spec.startsWith(`${mod.modulePath}/`)) rest = spec.slice(mod.modulePath.length + 1);
  else return [];
  const dir = rest === '' ? mod.dir : joinPath(mod.dir, rest);
  const names = await listDir(ctx, dir);
  const goFiles = names.filter((n) => n.endsWith('.go') && !n.endsWith('_test.go')).sort();
  if (goFiles.length === 0) return [];
  const last = (rest === '' ? mod.modulePath : rest).split('/').pop() ?? '';
  const preferred = goFiles.find((n) => n === `${last}.go`) ?? goFiles[0];
  return preferred === undefined ? [] : one(joinPath(dir, preferred), stmt.bindings);
}

// ---------------------------------------------------------------------------
// Java / Kotlin
// ---------------------------------------------------------------------------

const JVM_ROOT_SUFFIXES = [
  '',
  'src',
  'src/main/java',
  'src/main/kotlin',
  'app/src/main/java',
  'app/src/main/kotlin',
  'src/test/java',
  'src/test/kotlin',
];

async function resolveJvm(stmt: ImportStatement, from: FileKey, lang: LanguageKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const spec = stmt.specifier;
  if (spec.endsWith('*')) return [];
  const segs = spec.split('.').filter((s) => s !== '');
  if (segs.length === 0) return [];

  const sourceRoots: FileKey[] = [];
  let pkg = ctx.packageName;
  if (pkg === undefined) {
    let text: string | undefined;
    try {
      text = await ctx.fs.readText(from, 64 * 1024);
    } catch {
      text = undefined;
    }
    pkg = text === undefined ? '' : (readPackageName(scanCode('java', text).masked) ?? '');
    ctx.packageName = pkg;
  }
  if (pkg !== '') {
    const pkgPath = pkg.split('.').join('/');
    const d = dirname(from);
    if (d === pkgPath || d.endsWith(`/${pkgPath}`)) {
      sourceRoots.push(d.length === pkgPath.length ? '/' : d.slice(0, d.length - pkgPath.length - 1));
    }
  }
  for (const r of rootsFor(from, ctx)) {
    for (const suffix of JVM_ROOT_SUFFIXES) sourceRoots.push(suffix === '' ? r : joinPath(r, suffix));
  }

  const roots: FileKey[] = [];
  for (const r of new Set(sourceRoots)) {
    if (await dirMayContain(ctx, r, segs[0] as string)) roots.push(r);
  }
  const exts = lang === 'kotlin' ? ['.kt', '.java'] : ['.java', '.kt'];
  for (let k = segs.length; k >= 1; k -= 1) {
    const rel = segs.slice(0, k).join('/');
    const candidates: string[] = [];
    for (const r of roots) for (const e of exts) candidates.push(joinPath(r, rel + e));
    const hit = await firstExisting(ctx, candidates);
    if (hit) return one(hit, stmt.bindings);
  }
  return [];
}

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------

async function resolveC(stmt: ImportStatement, from: FileKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const spec = stmt.specifier.replace(/\\/g, '/');
  const roots = rootsFor(from, ctx);
  const candidates: string[] = [];
  if (!stmt.angle) {
    candidates.push(joinPath(dirname(from), spec));
    for (const r of roots) candidates.push(joinPath(r, spec));
  }
  for (const r of roots) {
    candidates.push(joinPath(r, 'include', spec));
    candidates.push(joinPath(r, 'src', spec));
  }
  return one(await firstExisting(ctx, candidates), stmt.bindings);
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function rustModuleDir(from: FileKey): FileKey {
  const base = basename(from);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dirname(from);
  return joinPath(dirname(from), base.replace(/\.rs$/, ''));
}

function crateSrcDir(from: FileKey, ctx: ResolveContext): FileKey | undefined {
  const root = innermostRoot(from, ctx);
  let d = dirname(from);
  for (let i = 0; i < 64; i += 1) {
    if (basename(d) === 'src') return d;
    if (d === root || dirname(d) === d || d === '') return undefined;
    d = dirname(d);
  }
  return undefined;
}

async function resolveRust(stmt: ImportStatement, from: FileKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  if (stmt.kind === 'mod') {
    const d = rustModuleDir(from);
    const name = stmt.specifier;
    return one(await firstExisting(ctx, [joinPath(d, `${name}.rs`), joinPath(d, name, 'mod.rs')]), stmt.bindings);
  }
  const segs = stmt.specifier.split('::').filter((s) => s !== '');
  const head = segs[0];
  let baseDir: FileKey | undefined;
  let k = 1;
  if (head === 'crate') baseDir = crateSrcDir(from, ctx);
  else if (head === 'self') baseDir = rustModuleDir(from);
  else if (head === 'super') {
    baseDir = dirname(rustModuleDir(from));
    while (segs[k] === 'super') {
      baseDir = dirname(baseDir);
      k += 1;
    }
  }
  if (baseDir === undefined) return [];
  const rest = segs.slice(k);
  for (let n = rest.length; n >= 1; n -= 1) {
    const path = joinPath(baseDir, rest.slice(0, n).join('/'));
    const file = await firstExisting(ctx, [`${path}.rs`, `${path}/mod.rs`]);
    if (file === undefined) continue;
    if (n < rest.length || stmt.bindings.length === 0) return one(file, stmt.bindings);
    // the whole path is a module: bindings that are themselves submodules get their own targets
    const out: ResolvedTarget[] = [];
    const remaining: ImportBinding[] = [];
    for (const b of stmt.bindings) {
      const sub = await firstExisting(ctx, [`${path}/${b.imported}.rs`, `${path}/${b.imported}/mod.rs`]);
      if (sub !== undefined && sub !== file) out.push({ key: sub, bindings: [b] });
      else remaining.push(b);
    }
    if (remaining.length > 0) out.push({ key: file, bindings: remaining });
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Ruby / PHP
// ---------------------------------------------------------------------------

async function resolveRuby(stmt: ImportStatement, from: FileKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const spec = stmt.specifier.replace(/\\/g, '/');
  const withExt = spec.endsWith('.rb') ? spec : `${spec}.rb`;
  if (stmt.relativeLevel > 0 || spec.startsWith('./') || spec.startsWith('../')) {
    return one(await firstExisting(ctx, [joinPath(dirname(from), withExt)]), stmt.bindings);
  }
  const candidates: string[] = [];
  for (const r of rootsFor(from, ctx)) {
    candidates.push(joinPath(r, 'lib', withExt), joinPath(r, withExt), joinPath(r, 'app', withExt));
  }
  return one(await firstExisting(ctx, candidates), stmt.bindings);
}

async function resolvePhp(stmt: ImportStatement, from: FileKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const bind = stmt.bindings;
  if (stmt.kind === 'include') {
    const spec = stmt.specifier.replace(/\\/g, '/');
    const candidates: string[] = [];
    if (stmt.relativeLevel > 0) candidates.push(joinPath(dirname(from), spec.replace(/^\/+/, '')));
    else {
      candidates.push(joinPath(dirname(from), spec));
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        for (const r of rootsFor(from, ctx)) candidates.push(joinPath(r, spec));
      }
    }
    return one(await firstExisting(ctx, candidates), bind);
  }

  const fqn = stmt.specifier.replace(/^\\/, '');
  const psr4 = ctx.project.psr4;
  if (psr4 && Object.keys(psr4).length > 0) {
    const prefixes = Object.keys(psr4)
      .filter((p) => fqn.startsWith(p))
      .sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      const rel = `${fqn.slice(prefix.length).split('\\').join('/')}.php`;
      const dirs = psr4[prefix] ?? [];
      const hit = await firstExisting(ctx, dirs.map((d) => joinPath(d, rel)));
      if (hit) return one(hit, bind);
    }
    return [];
  }

  const parts = fqn.split('\\');
  const roots = rootsFor(from, ctx);
  const bases: FileKey[] = [];
  for (const r of roots) bases.push(r, joinPath(r, 'src'), joinPath(r, 'app'), joinPath(r, 'lib'));
  let probes = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const rel = `${parts.slice(i).join('/')}.php`;
    for (const b of bases) {
      if (probes >= 16) return [];
      probes += 1;
      const p = joinPath(b, rel);
      if (await probeFile(ctx, p)) return one(p, bind);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// CSS family / HTML / Markdown
// ---------------------------------------------------------------------------

async function resolveStyle(stmt: ImportStatement, from: FileKey, lang: LanguageKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const spec = stmt.specifier.replace(/\\/g, '/');
  const base = joinPath(dirname(from), spec);
  const dir = dirname(base);
  const name = basename(base);
  const candidates: string[] = [base];
  if (lang === 'scss') {
    if (extname(name) === '') {
      candidates.push(`${base}.scss`, joinPath(dir, `_${name}.scss`), `${base}.css`, `${base}/_index.scss`, `${base}/index.scss`);
    } else candidates.push(joinPath(dir, `_${name}`));
  } else if (lang === 'less') {
    if (extname(name) === '') candidates.push(`${base}.less`, `${base}.css`);
  } else if (extname(name) === '') candidates.push(`${base}.css`);
  return one(await firstExisting(ctx, candidates), stmt.bindings);
}

async function resolveDocLink(stmt: ImportStatement, from: FileKey, lang: LanguageKey, ctx: ResolveContext): Promise<ResolvedTarget[]> {
  const raw = stmt.specifier.replace(/\\/g, '/');
  const specs = [raw];
  const decoded = safeDecode(raw);
  if (decoded !== raw) specs.push(decoded);
  const candidates: string[] = [];
  for (const spec of specs) {
    const bases: string[] = [];
    if (spec.startsWith('/')) for (const r of rootsFor(from, ctx)) bases.push(joinPath(r, spec.slice(1)));
    else bases.push(joinPath(dirname(from), spec));
    for (const b of bases) {
      if (spec.endsWith('/')) candidates.push(joinPath(b, 'index.html'));
      else {
        candidates.push(b);
        if (lang === 'markdown' && extname(b) === '') candidates.push(`${b}.md`);
      }
    }
  }
  return one(await firstExisting(ctx, candidates), stmt.bindings);
}

// ---------------------------------------------------------------------------

/** Resolves one import statement to 0..n workspace files. Never throws. */
export async function resolveImport(
  stmt: ImportStatement,
  from: FileKey,
  lang: LanguageKey,
  ctx: ResolveContext,
): Promise<ResolvedTarget[]> {
  try {
    const file = normalizePath(from);
    switch (lang) {
      case 'ts':
      case 'js':
        return await resolveJsLike(stmt, file, lang, ctx);
      case 'python':
        return await resolvePython(stmt, file, ctx);
      case 'go':
        return await resolveGo(stmt, ctx);
      case 'java':
      case 'kotlin':
        return await resolveJvm(stmt, file, lang, ctx);
      case 'c':
      case 'cpp':
        return await resolveC(stmt, file, ctx);
      case 'rust':
        return await resolveRust(stmt, file, ctx);
      case 'ruby':
        return await resolveRuby(stmt, file, ctx);
      case 'php':
        return await resolvePhp(stmt, file, ctx);
      case 'css':
      case 'scss':
      case 'less':
        return await resolveStyle(stmt, file, lang, ctx);
      case 'html':
      case 'markdown':
        return await resolveDocLink(stmt, file, lang, ctx);
    }
  } catch {
    return [];
  }
}
