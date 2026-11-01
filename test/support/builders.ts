import { dirname as posixDirname, basename as posixBasename } from 'node:path/posix';
import type {
  FileKey,
  ReferenceResult,
  ReferenceTarget,
  Snapshot,
  TrackedFile,
  ViewRow,
  WorkspaceRoot,
} from './types';

export const ROOT_WS: WorkspaceRoot = { key: '/ws', name: 'ws' };

export function trackedFile(key: FileKey, o: Partial<TrackedFile> = {}): TrackedFile {
  return {
    key,
    source: 'you',
    phase: 'active',
    intensity: 0.5,
    rate: 3,
    firstEditAt: 1000,
    lastEditAt: 1000,
    editCount: 3,
    ...o,
  };
}

export function refTarget(key: FileKey, count: number, o: Partial<ReferenceTarget> = {}): ReferenceTarget {
  return { key, count, statements: 1, usages: Math.max(0, count - 1), lines: [1], specifiers: ['./x'], ...o };
}

export function refResult(
  source: FileKey,
  targets: ReadonlyArray<{ key: FileKey; count: number }>,
  o: Partial<ReferenceResult> = {},
): ReferenceResult {
  return {
    source,
    language: 'ts',
    targets: targets.map((t) => refTarget(t.key, t.count)),
    truncated: false,
    unresolved: 0,
    parseMs: 1,
    ...o,
  };
}

/** A ViewRow for a file under the single root /ws (folderPath derived from the key). */
export function viewRow(key: FileKey, o: Partial<ViewRow> = {}): ViewRow {
  const rel = key.startsWith('/ws/') ? key.slice(4) : key.replace(/^\/+/, '');
  const relDir = posixDirname(rel) === '.' ? '' : posixDirname(rel);
  return {
    id: key,
    uri: `file://${key}`,
    name: posixBasename(key),
    dir: relDir,
    folderPath: relDir === '' ? [] : relDir.split('/'),
    role: 'edited',
    source: 'you',
    phase: 'active',
    intensity: 0.5,
    shake: { amp: 2.25, dur: 110, rot: 0.7 },
    refCount: 0,
    badge: 'typing',
    tooltip: 'Edited by you (typing) · 3 edits',
    ...o,
  };
}

export function snapshotOf(rows: ViewRow[], o: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    seq: 1,
    enabled: true,
    animate: true,
    colors: { edited: '', referenced: '' },
    rows,
    ...o,
  };
}
