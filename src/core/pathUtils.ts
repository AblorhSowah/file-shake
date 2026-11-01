import type { FileKey, WorkspaceRoot } from './types';

/** Splits a normalised path into its root prefix and the remaining segments. */
interface Parsed {
  root: string;
  segments: string[];
}

function parse(slashed: string): Parsed {
  let root = '';
  let rest = slashed;

  const drive = /^([A-Za-z]):(?:\/|$)/.exec(slashed);
  if (drive && drive[1] !== undefined) {
    root = `${drive[1].toLowerCase()}:/`;
    rest = slashed.slice(drive[0].length);
  } else if (/^\/\/[^/]/.test(slashed)) {
    // UNC: //server/share is the root
    const m = /^\/\/([^/]+)(?:\/+([^/]+))?/.exec(slashed);
    if (m && m[1] !== undefined) {
      root = m[2] !== undefined ? `//${m[1]}/${m[2]}` : `//${m[1]}`;
      rest = slashed.slice(m[0].length);
    }
  } else if (slashed.startsWith('/')) {
    root = '/';
    rest = slashed.replace(/^\/+/, '');
  }

  const segments: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== '..') segments.pop();
      else if (root === '') segments.push('..'); // relative path: keep leading '..'
      // absolute: never above root
      continue;
    }
    segments.push(seg);
  }
  return { root, segments };
}

function format(p: Parsed): string {
  const body = p.segments.join('/');
  if (p.root === '') return body;
  if (p.root.endsWith('/')) return p.root + body;
  return body === '' ? p.root : `${p.root}/${body}`;
}

/** '\' -> '/', collapse '//' (keep UNC lead), resolve '.' and '..' (never above root), strip trailing '/', lower-case 'C:'. */
export function normalizePath(p: string): string {
  if (p === '') return '';
  return format(parse(p.replace(/\\/g, '/')));
}

export function dirname(p: string): string {
  const parsed = parse(normalizePath(p));
  if (parsed.segments.length > 0) parsed.segments.pop();
  return format(parsed);
}

export function basename(p: string): string {
  const parsed = parse(normalizePath(p));
  return parsed.segments[parsed.segments.length - 1] ?? '';
}

/** Extension including the dot; '' for dotfiles like ".env". */
export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx);
}

/** Joins then normalises; an absolute later part resets the result. */
export function joinPath(...parts: string[]): string {
  let acc = '';
  for (const part of parts) {
    if (part === '') continue;
    if (acc === '' || isAbsolutePath(part)) acc = part;
    else acc = `${acc}/${part}`;
  }
  return normalizePath(acc);
}

export function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
}

/** `p === base || p startsWith base + '/'`; root-safe. */
export function isUnder(base: FileKey, p: FileKey): boolean {
  if (base === '') return p === '';
  if (p === base) return true;
  return base.endsWith('/') ? p.startsWith(base) : p.startsWith(`${base}/`);
}

/** '' when equal, undefined when `p` is not under `base`. */
export function relativeTo(base: FileKey, p: FileKey): string | undefined {
  if (!isUnder(base, p)) return undefined;
  if (p === base) return '';
  return base.endsWith('/') ? p.slice(base.length) : p.slice(base.length + 1);
}

export function hasSegment(p: string, seg: string): boolean {
  return p.split(/[\\/]/).includes(seg);
}

export interface DisplayPath {
  name: string;
  dir: string;
  folderPath: string[];
}

const OUTSIDE = '(outside workspace)';

export function toDisplayPath(key: FileKey, roots: readonly WorkspaceRoot[]): DisplayPath {
  const name = basename(key);
  let best: WorkspaceRoot | undefined;
  for (const r of roots) {
    if (isUnder(r.key, key) && key !== r.key && (!best || r.key.length > best.key.length)) best = r;
  }

  if (best) {
    const rel = relativeTo(best.key, key) ?? '';
    const segs = rel.split('/').filter((s) => s !== '');
    segs.pop(); // file name
    if (roots.length > 1) {
      const folderPath = [best.name, ...segs];
      return { name, dir: folderPath.join('/'), folderPath };
    }
    return { name, dir: segs.join('/'), folderPath: segs };
  }

  const absDir = dirname(key);
  const segs = absDir.split('/').filter((s) => s !== '');
  return { name, dir: absDir, folderPath: [OUTSIDE, ...segs] };
}
