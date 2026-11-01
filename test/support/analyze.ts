import { analyzeReferences, loadProjectInfo, parseImports, resolveImport } from './refs';
import { createMemFs } from './memfs';
import type { MemFs, MemFsOptions } from './memfs';
import type { LanguageKey, ReferenceResult, ResolvedTarget } from './types';

export interface RunOptions {
  /** Workspace roots; default ['/ws']. */
  roots?: string[];
  isExcluded?: (key: string) => boolean;
  maxFileSizeKb?: number;
  now?: () => number;
  fsOptions?: MemFsOptions;
  languageId?: string;
}

const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
};

export function languageIdFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return LANGUAGE_IDS[ext] ?? 'plaintext';
}

/**
 * Runs the real analysis pipeline (loadProjectInfo -> analyzeReferences) against an in-memory
 * file system. The source file is added to the file system automatically.
 */
export async function run(
  files: Readonly<Record<string, string>>,
  from: string,
  text: string,
  o: RunOptions = {},
): Promise<{ result: ReferenceResult; fs: MemFs; analyzeCalls: number }> {
  const all: Record<string, string> = { ...files };
  if (!(from in all)) all[from] = text;
  const fs = createMemFs(all, o.fsOptions);
  const roots = o.roots ?? ['/ws'];
  const project = await loadProjectInfo(fs, from, roots);
  const before = fs.totalCalls();
  const result = await analyzeReferences({
    path: from,
    languageId: o.languageId ?? languageIdFor(from),
    text,
    fs,
    project,
    isExcluded: o.isExcluded ?? ((): boolean => false),
    ...(o.maxFileSizeKb === undefined ? {} : { maxFileSizeKb: o.maxFileSizeKb }),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { result, fs, analyzeCalls: fs.totalCalls() - before };
}

/** Target keys of an analysis run, in the result's order. */
export async function targetsOf(
  files: Readonly<Record<string, string>>,
  from: string,
  text: string,
  o: RunOptions = {},
): Promise<string[]> {
  const { result } = await run(files, from, text, o);
  return result.targets.map((t) => t.key);
}

/** Parses `text` and resolves the first statement directly through resolveImport. */
export async function resolveFirst(
  lang: LanguageKey,
  from: string,
  text: string,
  files: Readonly<Record<string, string>>,
  o: { roots?: string[]; budget?: number } = {},
): Promise<{ targets: ResolvedTarget[]; fs: MemFs; budget: { probes: number }; memo: Map<string, boolean> }> {
  const all: Record<string, string> = { ...files };
  if (!(from in all)) all[from] = text;
  const fs = createMemFs(all);
  const roots = o.roots ?? ['/ws'];
  const project = await loadProjectInfo(fs, from, roots);
  const stmt = parseImports(lang, text)[0];
  if (!stmt) throw new Error(`no statement parsed from ${JSON.stringify(text)}`);
  const budget = { probes: o.budget ?? 400 };
  const memo = new Map<string, boolean>();
  const targets = await resolveImport(stmt, from, lang, { fs, project, isExcluded: () => false, budget, memo });
  return { targets, fs, budget, memo };
}
