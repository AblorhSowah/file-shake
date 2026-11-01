import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  dirname,
  extname,
  hasSegment,
  isAbsolutePath,
  isUnder,
  joinPath,
  normalizePath,
  relativeTo,
  toDisplayPath,
} from '../../src/core/pathUtils';

describe('normalizePath', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['/', '/'],
    ['/a/b/c.ts', '/a/b/c.ts'],
    ['/a//b///c', '/a/b/c'],
    ['/a/b/', '/a/b'],
    ['/a/./b', '/a/b'],
    ['/a/b/../c', '/a/c'],
    ['/a/b/../../c', '/c'],
    ['/a/b/../../../../c', '/c'],
    ['/..', '/'],
    ['/a/..', '/'],
    ['/../..', '/'],
    // Windows
    ['C:\\a\\b.ts', 'c:/a/b.ts'],
    ['C:/a\\b/./c/../d.ts', 'c:/a/b/d.ts'],
    ['C:\\', 'c:/'],
    ['C:/', 'c:/'],
    ['c:/', 'c:/'],
    ['D:\\X\\Y', 'd:/X/Y'],
    ['c:/..', 'c:/'],
    ['C:\\a\\..\\..\\b', 'c:/b'],
    // UNC
    ['//srv/share/a.ts', '//srv/share/a.ts'],
    ['\\\\srv\\share\\a.ts', '//srv/share/a.ts'],
    ['\\\\srv\\share\\sub\\..\\a.ts', '//srv/share/a.ts'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizePath(input), expected);
    });
  }

  it('only the drive letter is lower-cased; the rest of the path keeps its case (case-insensitive FS note)', () => {
    assert.equal(normalizePath('C:/Users/Foo/Bar.TS'), 'c:/Users/Foo/Bar.TS');
    assert.equal(normalizePath('/Users/Foo'), '/Users/Foo');
    assert.notEqual(normalizePath('/A.ts'), normalizePath('/a.ts'));
  });

  it('outputs never contain a backslash and the function is idempotent', () => {
    const inputs = [
      'C:\\a\\b\\..\\c.ts',
      '\\\\srv\\share\\x',
      '/a//b/../c/',
      'D:/x\\y//z',
      '/',
      'c:/',
      '/a/b/c',
    ];
    for (const i of inputs) {
      const once = normalizePath(i);
      assert.ok(!once.includes('\\'), once);
      assert.equal(normalizePath(once), once);
    }
  });

  it('all spellings of the same Windows file normalise to the same FileKey', () => {
    const spellings = ['C:\\proj\\src\\a.ts', 'c:\\proj\\src\\a.ts', 'C:/proj/src/a.ts', 'c:/proj//src/./a.ts', 'C:\\proj\\x\\..\\src\\a.ts'];
    const keys = new Set(spellings.map(normalizePath));
    assert.deepEqual([...keys], ['c:/proj/src/a.ts']);
  });

  it('relative inputs resolve . and .. without throwing', () => {
    assert.equal(normalizePath('a/b/../c'), 'a/c');
    assert.equal(normalizePath('./a'), 'a');
  });
});

describe('dirname / basename / extname', () => {
  it('dirname', () => {
    assert.equal(dirname('/a/b/c.ts'), '/a/b');
    assert.equal(dirname('/a/b'), '/a');
    assert.equal(dirname('/a'), '/');
    assert.equal(dirname('/'), '/');
    assert.equal(dirname('c:/a.ts'), 'c:/');
    assert.equal(dirname('c:/a/b.ts'), 'c:/a');
    assert.equal(dirname('//srv/share/a.ts'), '//srv/share');
  });

  it('dirname accepts backslashes and never returns one', () => {
    const d = dirname('c:\\a\\b.ts');
    assert.equal(d, 'c:/a');
    assert.ok(!dirname('C:\\a\\b\\c.ts').includes('\\'));
    assert.equal(dirname('C:\\a\\b\\c.ts').toLowerCase(), 'c:/a/b');
  });

  it('basename', () => {
    assert.equal(basename('/a/b/c.ts'), 'c.ts');
    assert.equal(basename('/a/b/'), 'b');
    assert.equal(basename('/a'), 'a');
    assert.equal(basename('/'), '');
    assert.equal(basename('c:/a/b.ts'), 'b.ts');
    assert.equal(basename('C:\\a\\b.ts'), 'b.ts');
    assert.equal(basename('.env'), '.env');
  });

  it('extname includes the dot and is empty for dotfiles / extensionless files', () => {
    assert.equal(extname('/a/b.ts'), '.ts');
    assert.equal(extname('/a/b.test.ts'), '.ts');
    assert.equal(extname('/a/x.d.ts'), '.ts');
    assert.equal(extname('/a/archive.tar.gz'), '.gz');
    assert.equal(extname('/a/.env'), '');
    assert.equal(extname('/a/.gitignore'), '');
    assert.equal(extname('/a/Makefile'), '');
    assert.equal(extname('/a.b/c'), '', 'a dot in a directory name is not an extension');
    assert.equal(extname('C:\\p\\file.PY'), '.PY');
  });
});

describe('joinPath', () => {
  it('joins and normalises', () => {
    assert.equal(joinPath('/a', 'b', 'c.ts'), '/a/b/c.ts');
    assert.equal(joinPath('/a', 'b', '../c'), '/a/c');
    assert.equal(joinPath('/a/', 'b'), '/a/b');
    assert.equal(joinPath('/a', ''), '/a');
    assert.equal(joinPath('/a/b', '..', '..', '..'), '/');
  });

  it('an absolute later part resets the path', () => {
    assert.equal(joinPath('/a', '/b', 'c'), '/b/c');
    assert.equal(joinPath('c:/a', 'd:/x'), 'd:/x');
    assert.equal(joinPath('/a', 'c:/x', 'y'), 'c:/x/y');
    assert.equal(joinPath('c:/a', '/b'), '/b');
  });

  it('handles backslashes', () => {
    assert.equal(joinPath('C:\\a', 'b\\c'), 'c:/a/b/c');
    assert.equal(joinPath('C:\\a', '..\\b'), 'c:/b');
  });
});

describe('isAbsolutePath', () => {
  it('recognises POSIX, drive and UNC paths', () => {
    for (const p of ['/x', '/', 'c:/x', 'C:/x', 'c:\\x', 'C:\\x', '//srv/x', '\\\\srv\\x']) {
      assert.equal(isAbsolutePath(p), true, p);
    }
  });
  it('rejects relative paths and the empty string', () => {
    for (const p of ['', 'x', 'x/y', './x', '../x', 'src\\a.ts']) {
      assert.equal(isAbsolutePath(p), false, JSON.stringify(p));
    }
  });
});

describe('isUnder / relativeTo / hasSegment', () => {
  it('isUnder is reflexive and respects segment boundaries', () => {
    assert.equal(isUnder('/a', '/a'), true);
    assert.equal(isUnder('/a', '/a/b'), true);
    assert.equal(isUnder('/a', '/a/b/c.ts'), true);
    assert.equal(isUnder('/a', '/ab'), false);
    assert.equal(isUnder('/a', '/ab/c'), false);
    assert.equal(isUnder('/a/b', '/a'), false);
    assert.equal(isUnder('/a', '/b'), false);
  });

  it('isUnder is root-safe', () => {
    assert.equal(isUnder('/', '/a'), true);
    assert.equal(isUnder('/', '/'), true);
    assert.equal(isUnder('c:/', 'c:/x/y'), true);
    assert.equal(isUnder('c:/', 'd:/x'), false);
    assert.equal(isUnder('c:/p', 'c:/p/a.ts'), true);
  });

  it('relativeTo returns "" for equal, a POSIX relative path, or undefined', () => {
    assert.equal(relativeTo('/a', '/a'), '');
    assert.equal(relativeTo('/a', '/a/b/c.ts'), 'b/c.ts');
    assert.equal(relativeTo('/', '/a/b'), 'a/b');
    assert.equal(relativeTo('c:/p', 'c:/p/src/a.ts'), 'src/a.ts');
    assert.equal(relativeTo('/a', '/ab/c'), undefined);
    assert.equal(relativeTo('/a/b', '/a'), undefined);
    assert.equal(relativeTo('/a', '/z/y'), undefined);
  });

  it('hasSegment matches whole segments only, with either separator', () => {
    assert.equal(hasSegment('/a/node_modules/b/c.js', 'node_modules'), true);
    assert.equal(hasSegment('/node_modules', 'node_modules'), true);
    assert.equal(hasSegment('node_modules/x', 'node_modules'), true);
    assert.equal(hasSegment('/a/my_node_modules/b', 'node_modules'), false);
    assert.equal(hasSegment('/a/node_modules_extra/b', 'node_modules'), false);
    assert.equal(hasSegment('/a/b/c.ts', 'node_modules'), false);
    assert.equal(hasSegment('c:\\a\\node_modules\\x', 'node_modules'), true);
    assert.equal(hasSegment('', 'node_modules'), false);
  });
});

describe('toDisplayPath', () => {
  const single = [{ key: '/w/p', name: 'p' }];
  const multi = [
    { key: '/w/a', name: 'a' },
    { key: '/w/b', name: 'b' },
  ];

  it('single root: relative folder path, dir is the relative dir', () => {
    assert.deepEqual(toDisplayPath('/w/p/src/a/b.ts', single), { name: 'b.ts', dir: 'src/a', folderPath: ['src', 'a'] });
    assert.deepEqual(toDisplayPath('/w/p/x.ts', single), { name: 'x.ts', dir: '', folderPath: [] });
  });

  it('multiple roots: folderPath starts with the root name', () => {
    assert.deepEqual(toDisplayPath('/w/a/src/x.ts', multi), { name: 'x.ts', dir: 'a/src', folderPath: ['a', 'src'] });
    assert.deepEqual(toDisplayPath('/w/b/x.ts', multi), { name: 'x.ts', dir: 'b', folderPath: ['b'] });
  });

  it('same file name in two roots stays distinguishable', () => {
    const a = toDisplayPath('/w/a/x.ts', multi);
    const b = toDisplayPath('/w/b/x.ts', multi);
    assert.notDeepEqual(a.folderPath, b.folderPath);
  });

  it('nested roots: the longest matching root wins', () => {
    const nested = [
      { key: '/w', name: 'outer' },
      { key: '/w/inner', name: 'inner' },
    ];
    assert.deepEqual(toDisplayPath('/w/inner/x.ts', nested), { name: 'x.ts', dir: 'inner', folderPath: ['inner'] });
    assert.deepEqual(toDisplayPath('/w/inner/deep/y.ts', nested), { name: 'y.ts', dir: 'inner/deep', folderPath: ['inner', 'deep'] });
    assert.deepEqual(toDisplayPath('/w/top.ts', nested), { name: 'top.ts', dir: 'outer', folderPath: ['outer'] });
    // order of the roots array must not matter
    const reversed = [...nested].reverse();
    assert.deepEqual(toDisplayPath('/w/inner/x.ts', reversed), { name: 'x.ts', dir: 'inner', folderPath: ['inner'] });
  });

  it('a root that is a string prefix of another directory does not match it', () => {
    const roots = [{ key: '/w/p', name: 'p' }];
    const d = toDisplayPath('/w/proj/x.ts', roots);
    assert.equal(d.folderPath[0], '(outside workspace)');
  });

  it('outside any root (or no folder open): "(outside workspace)" + absolute dir segments', () => {
    assert.deepEqual(toDisplayPath('/other/dir/x.ts', single), {
      name: 'x.ts',
      dir: '/other/dir',
      folderPath: ['(outside workspace)', 'other', 'dir'],
    });
    assert.deepEqual(toDisplayPath('/other/dir/x.ts', []), {
      name: 'x.ts',
      dir: '/other/dir',
      folderPath: ['(outside workspace)', 'other', 'dir'],
    });
  });
});
