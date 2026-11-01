import picomatch from 'picomatch';
import { relativeTo } from './pathUtils';
import type { FileKey, WorkspaceRoot } from './types';

/** Compiles glob strings (picomatch, dotfiles included). Invalid entries are skipped; [] excludes nothing. */
export function createExcludeMatcher(
  globs: readonly string[],
  opts: { nocase?: boolean } = {},
): (relPath: string) => boolean {
  const matchers: Array<(s: string) => boolean> = [];
  for (const g of globs) {
    if (typeof g !== 'string' || g === '') continue;
    try {
      matchers.push(picomatch(g, { dot: true, nocase: opts.nocase === true }));
    } catch {
      // invalid pattern: skip
    }
  }
  if (matchers.length === 0) return () => false;
  return (relPath: string): boolean => {
    for (const m of matchers) {
      try {
        if (m(relPath)) return true;
      } catch {
        // ignore a matcher that throws
      }
    }
    return false;
  };
}

/** Path relative to the containing (longest) root, else the absolute path without its leading '/'. */
export function relativeForMatch(key: FileKey, roots: readonly WorkspaceRoot[]): string {
  let best: WorkspaceRoot | undefined;
  for (const r of roots) {
    if (relativeTo(r.key, key) !== undefined && (!best || r.key.length > best.key.length)) best = r;
  }
  if (best) return relativeTo(best.key, key) ?? '';
  return key.replace(/^\/+/, '');
}
