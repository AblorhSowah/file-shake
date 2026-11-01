import type { ProbeFs } from './types';

export interface MemFsOptions {
  /** Make the named operations throw synchronously. */
  throwOn?: ReadonlyArray<'isFile' | 'listDir' | 'readText'>;
  /** Make the named operations reject asynchronously. */
  rejectOn?: ReadonlyArray<'isFile' | 'listDir' | 'readText'>;
}

export interface MemFs extends ProbeFs {
  readonly files: ReadonlyMap<string, string>;
  readonly calls: { isFile: string[]; listDir: string[]; readText: string[] };
  totalCalls(): number;
}

/**
 * In-memory ProbeFs built from `{ "/abs/posix/path": "content" }`. Keys must already be
 * normalised FileKeys. Directories exist implicitly (any prefix of a file path); `isFile`
 * is true for files only.
 */
export function createMemFs(files: Readonly<Record<string, string>>, opts: MemFsOptions = {}): MemFs {
  const map = new Map<string, string>(Object.entries(files));
  const calls = { isFile: [] as string[], listDir: [] as string[], readText: [] as string[] };
  const boom = (op: 'isFile' | 'listDir' | 'readText'): void => {
    if (opts.throwOn?.includes(op)) throw new Error(`memfs: ${op} exploded`);
  };
  const reject = (op: 'isFile' | 'listDir' | 'readText'): boolean => opts.rejectOn?.includes(op) === true;

  return {
    files: map,
    calls,
    totalCalls: () => calls.isFile.length + calls.listDir.length + calls.readText.length,
    async isFile(p: string): Promise<boolean> {
      calls.isFile.push(p);
      boom('isFile');
      if (reject('isFile')) throw new Error('memfs: isFile rejected');
      return map.has(p);
    },
    async listDir(p: string): Promise<string[]> {
      calls.listDir.push(p);
      boom('listDir');
      if (reject('listDir')) throw new Error('memfs: listDir rejected');
      const prefix = p.endsWith('/') ? p : p + '/';
      const names = new Set<string>();
      for (const f of map.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const name = rest.split('/')[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    async readText(p: string, maxBytes: number): Promise<string | undefined> {
      calls.readText.push(p);
      boom('readText');
      if (reject('readText')) throw new Error('memfs: readText rejected');
      const content = map.get(p);
      return content === undefined ? undefined : content.slice(0, maxBytes);
    },
  };
}
