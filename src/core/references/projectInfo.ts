import { parse as parseJsonc } from 'jsonc-parser';
import { dirname, isUnder, joinPath, normalizePath } from '../pathUtils';
import type { FileKey, ProbeFs, ProjectInfo } from '../types';
import { detectLanguage } from './parsers/index';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 3;

interface TsOptions {
  baseUrl?: FileKey;
  paths?: Record<string, string[]>;
  pathsDir?: FileKey;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(fs: ProbeFs, file: FileKey): Promise<unknown> {
  let text: string | undefined;
  try {
    text = await fs.readText(file, MAX_CONFIG_BYTES);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  try {
    return parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return undefined;
  }
}

/** Reads compilerOptions of a tsconfig/jsconfig, following relative `extends` (child overrides parent). */
async function loadTsOptions(fs: ProbeFs, file: FileKey, depth: number): Promise<TsOptions | undefined> {
  const json = await readJson(fs, file);
  if (!isRecord(json)) return undefined;
  const dir = dirname(file);
  let result: TsOptions = {};

  const ext = json['extends'];
  const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.filter((e): e is string => typeof e === 'string') : [];
  if (depth < MAX_EXTENDS_DEPTH) {
    for (const p of parents) {
      if (!p.startsWith('.')) continue;
      let target = joinPath(dir, p);
      if (!target.endsWith('.json')) target += '.json';
      const parent = await loadTsOptions(fs, target, depth + 1);
      if (parent) result = { ...result, ...parent };
    }
  }

  const co = json['compilerOptions'];
  if (isRecord(co)) {
    if (typeof co['baseUrl'] === 'string') result.baseUrl = joinPath(dir, co['baseUrl']);
    const paths = co['paths'];
    if (isRecord(paths)) {
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(paths)) {
        if (Array.isArray(v)) clean[k] = v.filter((x): x is string => typeof x === 'string');
      }
      result.paths = clean;
      result.pathsDir = dir;
    }
  }
  return result;
}

async function findUp(fs: ProbeFs, dirs: readonly FileKey[], names: readonly string[]): Promise<{ file: FileKey; dir: FileKey } | undefined> {
  for (const d of dirs) {
    for (const name of names) {
      const file = joinPath(d, name);
      let exists: boolean;
      try {
        exists = await fs.isFile(file);
      } catch {
        exists = false;
      }
      if (exists) return { file, dir: d };
    }
  }
  return undefined;
}

/**
 * Per-project resolution inputs (tsconfig paths, go.mod, composer psr-4), discovered by walking up
 * from the analysed file to its workspace root. Only reads what the file's language needs.
 */
export async function loadProjectInfo(fs: ProbeFs, from: FileKey, roots: readonly FileKey[]): Promise<ProjectInfo> {
  const file = normalizePath(from);
  const normRoots = roots.map(normalizePath);
  let containing: FileKey | undefined;
  for (const r of normRoots) {
    if (isUnder(r, file) && (containing === undefined || r.length > containing.length)) containing = r;
  }
  // A file outside every workspace root is analysed with roots = [dirname(file)] by the adapter;
  // here the given roots are kept as they are (an empty list falls back to the file's directory).
  const info: ProjectInfo = { roots: normRoots.length > 0 ? normRoots : [dirname(file)] };

  const stop = containing ?? dirname(file);
  const ancestors: FileKey[] = [];
  let d = dirname(file);
  for (let i = 0; i < 64; i += 1) {
    ancestors.push(d);
    if (d === stop || dirname(d) === d || d === '') break;
    d = dirname(d);
  }

  const lang = detectLanguage('', file);
  try {
    if (lang === 'ts' || lang === 'js') {
      const found = await findUp(fs, ancestors, ['tsconfig.json', 'jsconfig.json']);
      if (found) {
        const opts = await loadTsOptions(fs, found.file, 0);
        if (opts) {
          info.tsconfig = {
            dir: opts.pathsDir ?? found.dir,
            paths: opts.paths ?? {},
            ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
          };
        }
      }
    } else if (lang === 'go') {
      for (const dir of ancestors) {
        let text: string | undefined;
        try {
          text = await fs.readText(joinPath(dir, 'go.mod'), MAX_CONFIG_BYTES);
        } catch {
          text = undefined;
        }
        if (text === undefined) continue;
        const m = /^[ \t]*module[ \t]+"?([^\s"]+)"?/m.exec(text);
        if (m && m[1] !== undefined) info.goModule = { dir, modulePath: m[1] };
        break;
      }
    } else if (lang === 'php') {
      const found = await findUp(fs, ancestors, ['composer.json']);
      if (found) {
        const json = await readJson(fs, found.file);
        if (isRecord(json)) {
          const psr4: Record<string, FileKey[]> = {};
          for (const section of ['autoload', 'autoload-dev']) {
            const a = json[section];
            const map = isRecord(a) ? a['psr-4'] : undefined;
            if (!isRecord(map)) continue;
            for (const [prefix, target] of Object.entries(map)) {
              const dirs = typeof target === 'string' ? [target] : Array.isArray(target) ? target.filter((t): t is string => typeof t === 'string') : [];
              const abs = dirs.map((t) => joinPath(found.dir, t));
              psr4[prefix] = [...(psr4[prefix] ?? []), ...abs];
            }
          }
          if (Object.keys(psr4).length > 0) info.psr4 = psr4;
        }
      }
    }
  } catch {
    // best effort: project info is optional
  }
  return info;
}
