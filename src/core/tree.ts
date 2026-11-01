import type { FileKey, Role, ViewRow } from './types';

export interface FolderNode {
  kind: 'folder';
  id: string;
  label: string;
  children: TreeNode[];
  fileCount: number;
  topRole: Role | null;
  hasActive: boolean;
}

export interface FileNode {
  kind: 'file';
  id: FileKey;
  row: ViewRow;
}

export type TreeNode = FolderNode | FileNode;

interface Raw {
  segments: string[];
  folders: Map<string, Raw>;
  files: ViewRow[];
}

function newRaw(segments: string[]): Raw {
  return { segments, folders: new Map(), files: [] };
}

function collator(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function convert(raw: Raw, label: string, segments: string[]): FolderNode {
  // compaction: a folder whose only child is a single folder merges with it
  let cur = raw;
  let lbl = label;
  let segs = segments;
  while (cur.files.length === 0 && cur.folders.size === 1) {
    const only = [...cur.folders.values()][0] as Raw;
    lbl = `${lbl}/${only.segments[only.segments.length - 1] as string}`;
    segs = only.segments;
    cur = only;
  }

  const children: TreeNode[] = [];
  const folders = [...cur.folders.values()].map((f) => convert(f, f.segments[f.segments.length - 1] as string, f.segments));
  folders.sort((a, b) => collator(a.label, b.label));
  children.push(...folders);
  const files = [...cur.files].sort((a, b) => collator(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const row of files) children.push({ kind: 'file', id: row.id, row });

  let fileCount = 0;
  let edited = false;
  let active = false;
  for (const c of children) {
    if (c.kind === 'folder') {
      fileCount += c.fileCount;
      edited = edited || c.topRole === 'edited';
      active = active || c.hasActive;
    } else {
      fileCount += 1;
      edited = edited || c.row.role === 'edited';
      active = active || c.row.phase === 'active';
    }
  }
  return {
    kind: 'folder',
    id: segs.join('/'),
    label: lbl,
    children,
    fileCount,
    topRole: fileCount === 0 ? null : edited ? 'edited' : 'referenced',
    hasActive: active,
  };
}

/** Compact folder tree of the given rows, alphabetical (never by intensity, so shaking rows do not jump). */
export function buildTree(rows: readonly ViewRow[]): TreeNode[] {
  const root = newRaw([]);
  for (const row of rows) {
    let node = root;
    const path: string[] = [];
    for (const seg of row.folderPath) {
      path.push(seg);
      let next = node.folders.get(seg);
      if (!next) {
        next = newRaw([...path]);
        node.folders.set(seg, next);
      }
      node = next;
    }
    node.files.push(row);
  }

  const top: TreeNode[] = [];
  const folders = [...root.folders.values()].map((f) => convert(f, f.segments[0] as string, f.segments));
  folders.sort((a, b) => collator(a.label, b.label));
  top.push(...folders);
  const files = [...root.files].sort((a, b) => collator(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const row of files) top.push({ kind: 'file', id: row.id, row });
  return top;
}
