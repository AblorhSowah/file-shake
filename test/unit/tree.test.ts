import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../../src/core/tree';
import type { FileNode, FolderNode, TreeNode } from '../../src/core/tree';
import { viewRow } from '../support/builders';
import { must } from '../support/fixtures';
import type { ViewRow } from '../support/types';

const folder = (n: TreeNode | undefined): FolderNode => {
  const node = must(n, 'node');
  assert.equal(node.kind, 'folder', `expected a folder, got a file (${node.id})`);
  return node as FolderNode;
};
const file = (n: TreeNode | undefined): FileNode => {
  const node = must(n, 'node');
  assert.equal(node.kind, 'file', `expected a file, got a folder (${node.id})`);
  return node as FileNode;
};
const labels = (nodes: TreeNode[]): string[] => nodes.map((n) => (n.kind === 'folder' ? `${n.label}/` : n.row.name));

function r(key: string, o: Partial<ViewRow> = {}): ViewRow {
  return viewRow(key, o);
}

describe('buildTree', () => {
  it('empty -> empty', () => assert.deepEqual(buildTree([]), []));

  it('a root-level file is a bare FileNode whose id is the row id and which carries the row', () => {
    const row = r('/ws/a.ts');
    const tree = buildTree([row]);
    assert.equal(tree.length, 1);
    const f = file(tree[0]);
    assert.equal(f.id, '/ws/a.ts');
    assert.equal(f.row, row);
  });

  it('a folder with a single file child is NOT compacted away (only folder-only chains merge)', () => {
    const tree = buildTree([r('/ws/src/a.ts')]);
    const f = folder(tree[0]);
    assert.equal(f.label, 'src');
    assert.equal(f.id, 'src');
    assert.equal(f.children.length, 1);
    assert.equal(file(f.children[0]).row.name, 'a.ts');
  });

  it('chains of folders whose only child is a folder are compacted: label a/b/c, id of the deepest folder', () => {
    const tree = buildTree([r('/ws/a/b/c/x.ts'), r('/ws/a/b/c/y.ts')]);
    assert.equal(tree.length, 1);
    const f = folder(tree[0]);
    assert.equal(f.label, 'a/b/c');
    assert.equal(f.id, 'a/b/c');
    assert.deepEqual(labels(f.children), ['x.ts', 'y.ts']);
  });

  it('a folder that also holds a file, or two folders, is not merged with its child', () => {
    const tree = buildTree([r('/ws/src/top.ts'), r('/ws/src/lib/deep.ts')]);
    const src = folder(tree[0]);
    assert.equal(src.label, 'src');
    assert.equal(src.id, 'src');
    assert.deepEqual(labels(src.children), ['lib/', 'top.ts']);
    const lib = folder(src.children[0]);
    assert.equal(lib.id, 'src/lib');
    assert.equal(lib.label, 'lib');

    const two = buildTree([r('/ws/src/x/a.ts'), r('/ws/src/y/b.ts')]);
    const s = folder(two[0]);
    assert.equal(s.label, 'src');
    assert.deepEqual(
      s.children.map((c) => c.id),
      ['src/x', 'src/y'],
    );
  });

  it('ids are the full segment path joined by "/" for every non-compacted folder', () => {
    const tree = buildTree([r('/ws/a/p/1.ts'), r('/ws/a/p/q/2.ts'), r('/ws/a/z/3.ts')]);
    const a = folder(tree[0]);
    assert.equal(a.id, 'a');
    const ids = a.children.map((c) => c.id);
    assert.deepEqual(ids, ['a/p', 'a/z']);
    const p = folder(a.children[0]);
    assert.deepEqual(
      p.children.map((c) => c.id),
      ['a/p/q', '/ws/a/p/1.ts'],
    );
  });

  it('folders sort before files; each group sorts with localeCompare(en, numeric)', () => {
    const rows = ['file10.ts', 'file2.ts', 'a.ts', 'B.ts', 'file1.ts'].map((n) => r(`/ws/${n}`));
    const tree = buildTree([...rows, r('/ws/zdir/x.ts'), r('/ws/Adir/y.ts'), r('/ws/dir10/q.ts'), r('/ws/dir2/q.ts')]);
    assert.deepEqual(labels(tree), ['Adir/', 'dir2/', 'dir10/', 'zdir/', 'a.ts', 'B.ts', 'file1.ts', 'file2.ts', 'file10.ts']);
  });

  it('never orders by intensity or role: swapping intensities does not reorder siblings', () => {
    const lo = r('/ws/a.ts', { intensity: 0.1 });
    const hi = r('/ws/b.ts', { intensity: 0.9, role: 'referenced', source: null });
    const first = buildTree([lo, hi]);
    const swapped = buildTree([{ ...lo, intensity: 0.9 }, { ...hi, intensity: 0.1 }]);
    assert.deepEqual(labels(first), ['a.ts', 'b.ts']);
    assert.deepEqual(labels(swapped), ['a.ts', 'b.ts']);
    assert.deepEqual(labels(buildTree([hi, lo])), ['a.ts', 'b.ts'], 'input order is irrelevant too');
  });

  it('fileCount counts descendant files, not folders', () => {
    const tree = buildTree([r('/ws/s/a.ts'), r('/ws/s/b.ts'), r('/ws/s/deep/c.ts'), r('/ws/s/deep/er/d.ts')]);
    const s = folder(tree[0]);
    assert.equal(s.fileCount, 4);
    const deep = folder(s.children[0]);
    assert.equal(deep.fileCount, 2);
  });

  it('topRole is "edited" if any descendant is edited, else "referenced"', () => {
    const edited = buildTree([r('/ws/s/a.ts'), r('/ws/s/deep/b.ts', { role: 'referenced', source: null })]);
    assert.equal(folder(edited[0]).topRole, 'edited');
    const deep = folder(folder(edited[0]).children[0]);
    assert.equal(deep.topRole, 'referenced');
    const only = buildTree([r('/ws/s/deep/b.ts', { role: 'referenced', source: null }), r('/ws/s/deep/c.ts', { role: 'referenced', source: null })]);
    assert.equal(folder(only[0]).topRole, 'referenced');
    const nested = buildTree([r('/ws/s/x/e.ts'), r('/ws/s/y/r.ts', { role: 'referenced', source: null })]);
    assert.equal(folder(nested[0]).topRole, 'edited', 'a deep edited file marks all ancestors');
  });

  it('hasActive is true if any descendant is active', () => {
    const t = buildTree([r('/ws/s/a.ts', { phase: 'idle' }), r('/ws/s/deep/b.ts', { phase: 'active' }), r('/ws/q/c.ts', { phase: 'idle' }), r('/ws/q/d.ts', { phase: 'idle' })]);
    const s = folder(t.find((n) => n.id === 's'));
    assert.equal(s.hasActive, true);
    const q = folder(t.find((n) => n.id === 'q'));
    assert.equal(q.hasActive, false);
  });

  it('aggregates of a compacted folder cover everything beneath it', () => {
    const tree = buildTree([r('/ws/a/b/x.ts', { phase: 'idle' }), r('/ws/a/b/y.ts', { role: 'referenced', source: null })]);
    const ab = folder(tree[0]);
    assert.equal(ab.label, 'a/b');
    assert.equal(ab.fileCount, 2);
    assert.equal(ab.topRole, 'edited');
    assert.equal(ab.hasActive, true);
  });

  it('multi-root: root name is the top folder; a lone subfolder compacts into it; same file name stays distinct', () => {
    const a = r('/w/a/src/x.ts', { folderPath: ['alpha', 'src'], dir: 'alpha/src' });
    const b = r('/w/b/x.ts', { folderPath: ['beta'], dir: 'beta' });
    const tree = buildTree([a, b]);
    assert.deepEqual(labels(tree), ['alpha/src/', 'beta/']);
    assert.equal(folder(tree[0]).id, 'alpha/src');
    assert.deepEqual(
      tree.map((n) => file(folder(n).children[0]).id),
      ['/w/a/src/x.ts', '/w/b/x.ts'],
    );
  });

  it('outside-workspace files are grouped under a compacted "(outside workspace)/..." folder', () => {
    const row = r('/tmp/loose/a.ts', { folderPath: ['(outside workspace)', 'tmp', 'loose'], dir: '/tmp/loose' });
    const tree = buildTree([row]);
    assert.equal(folder(tree[0]).label, '(outside workspace)/tmp/loose');
    assert.equal(folder(tree[0]).id, '(outside workspace)/tmp/loose');
  });

  it('a file and a folder with the same name coexist', () => {
    const tree = buildTree([r('/ws/lib'), r('/ws/lib/x.ts')]);
    assert.equal(tree.length, 2);
    assert.equal(tree[0]?.kind, 'folder');
    assert.equal(tree[1]?.kind, 'file');
  });

  it('does not mutate the rows or reorder the input array', () => {
    const rows = [r('/ws/z/b.ts'), r('/ws/a.ts')];
    const snapshot = JSON.stringify(rows);
    const ids = rows.map((x) => x.id);
    Object.freeze(rows);
    rows.forEach((x) => Object.freeze(x));
    assert.doesNotThrow(() => buildTree(rows));
    assert.equal(JSON.stringify(rows), snapshot);
    assert.deepEqual(
      rows.map((x) => x.id),
      ids,
    );
  });

  it('handles hostile folder and file names as plain strings', () => {
    const row = r('/ws/<img onerror=x>/"q"/a.ts', { name: '<b>a</b>.ts', folderPath: ['<img onerror=x>', '"q"'], dir: '<img onerror=x>/"q"' });
    const tree = buildTree([row]);
    assert.equal(folder(tree[0]).label, '<img onerror=x>/"q"');
  });

  it('handles 500 rows quickly and keeps every file exactly once', () => {
    const rows: ViewRow[] = [];
    for (let i = 0; i < 500; i++) rows.push(r(`/ws/d${i % 17}/s${i % 5}/f${i}.ts`));
    const t0 = performance.now();
    const tree = buildTree(rows);
    const elapsed = performance.now() - t0;
    const seen: string[] = [];
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'file') seen.push(n.id);
        else walk(n.children);
      }
    };
    walk(tree);
    assert.equal(seen.length, 500);
    assert.equal(new Set(seen).size, 500);
    assert.ok(elapsed < 200, `buildTree took ${elapsed.toFixed(1)}ms`);
  });
});
