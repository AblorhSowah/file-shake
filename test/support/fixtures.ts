import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Absolute path of the repository root (tests are always started from it, or live under it). */
export const REPO_ROOT: string =
  typeof __dirname === 'string' ? join(__dirname, '..', '..') : process.cwd();

export const FIXTURES_DIR: string = join(REPO_ROOT, 'test', 'fixtures');

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES_DIR, ...parts);
}

export function readFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8');
}

export function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

/** 1-based line number of the first occurrence of `needle` in `text`. Throws if absent (fixture drift). */
export function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`fixture does not contain: ${needle}`);
  let line = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Non-null helper for noUncheckedIndexedAccess. */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
  return value;
}
