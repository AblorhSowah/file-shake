import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExcludeMatcher, relativeForMatch } from '../../src/core/glob';
import { DEFAULT_CONFIG } from '../../src/core/config';

describe('createExcludeMatcher with the default globs', () => {
  const m = createExcludeMatcher(DEFAULT_CONFIG.excludeGlobs);

  const excluded = [
    'node_modules/x/index.js',
    'a/node_modules/b.js',
    'a/b/node_modules/c/d/e.ts',
    '.git/config',
    'sub/.git/HEAD',
    'dist/out.js',
    'packages/x/dist/bundle.js',
    'out/integration/a.test.js',
    'build/x',
    'coverage/lcov.info',
    '.next/server/page.js',
    '.venv/lib/x.py',
    'pkg/__pycache__/m.pyc',
    '.vscode-test/vscode/x',
    'static/app.min.js',
    'x.min.js',
    'dist/a.js.map',
    'app.js.map',
    'logs/app.log',
    'debug.log',
    'ext/file-shake-0.1.0.vsix',
    'package-lock.json',
    'sub/package-lock.json',
    'yarn.lock',
    'a/b/pnpm-lock.yaml',
  ];
  for (const p of excluded) {
    it(`excludes ${p}`, () => assert.equal(m(p), true));
  }

  const kept = [
    'src/index.ts',
    'index.ts',
    'README.md',
    'src/node_modules_helper.ts',
    'src/distribution/a.ts',
    'src/build.ts',
    'src/app.js',
    'package.json',
    'src/minified.txt',
    'lib/x.ts',
    'src/outline/x.ts',
    '.github/workflows/ci.yml',
    '.vscode/settings.json',
  ];
  for (const p of kept) {
    it(`keeps ${p}`, () => assert.equal(m(p), false));
  }
});

describe('createExcludeMatcher: edge cases', () => {
  it('an empty list excludes nothing', () => {
    const m = createExcludeMatcher([]);
    assert.equal(m('anything/at/all.ts'), false);
    assert.equal(m('node_modules/x.js'), false);
    assert.equal(m(''), false);
  });

  it('dot files are matched (dot: true)', () => {
    const m = createExcludeMatcher(['**/*.map']);
    assert.equal(m('dir/.hidden.map'), true);
    assert.equal(createExcludeMatcher(['**/.git/**'])('.git/objects/ab/cd'), true);
  });

  it('invalid or non-string entries are skipped and never throw; valid ones still work', () => {
    const weird = ['[', '{a,b', '(', '\\', '**/*.log', 5, null, undefined, {}, ''] as unknown as string[];
    let m: (p: string) => boolean = () => false;
    assert.doesNotThrow(() => {
      m = createExcludeMatcher(weird);
    });
    assert.equal(m('x/app.log'), true);
    assert.equal(m('x/app.ts'), false);
    assert.doesNotThrow(() => m('anything'));
    assert.doesNotThrow(() => m('[weird]/path(1)'));
  });

  it('nocase option', () => {
    const sensitive = createExcludeMatcher(['**/index.ts']);
    const insensitive = createExcludeMatcher(['**/index.ts'], { nocase: true });
    assert.equal(sensitive('A/INDEX.TS'), false);
    assert.equal(insensitive('A/INDEX.TS'), true);
  });

  it('custom patterns: single star does not cross directories, double star does', () => {
    const m = createExcludeMatcher(['src/*.gen.ts', 'generated/**']);
    assert.equal(m('src/a.gen.ts'), true);
    assert.equal(m('src/deep/a.gen.ts'), false);
    assert.equal(m('generated/a/b/c.ts'), true);
  });

  it('a user can exclude by extension everywhere', () => {
    const m = createExcludeMatcher(['**/*.ts']);
    assert.equal(m('a.ts'), true);
    assert.equal(m('a/b/c.ts'), true);
    assert.equal(m('a/b/c.tsx'), false);
  });

  it('paths outside the workspace (absolute without leading slash) match like any other', () => {
    const m = createExcludeMatcher(DEFAULT_CONFIG.excludeGlobs);
    assert.equal(m('other/project/node_modules/x/index.js'), true);
    assert.equal(m('other/project/src/index.ts'), false);
  });
});

describe('relativeForMatch', () => {
  const roots = [{ key: '/w/p', name: 'p' }];

  it('relative to the containing root', () => {
    assert.equal(relativeForMatch('/w/p/src/a.ts', roots), 'src/a.ts');
    assert.equal(relativeForMatch('/w/p/a.ts', roots), 'a.ts');
  });

  it('multi-root: relative to whichever root contains it', () => {
    const multi = [
      { key: '/w/a', name: 'a' },
      { key: '/w/b', name: 'b' },
    ];
    assert.equal(relativeForMatch('/w/a/x/y.ts', multi), 'x/y.ts');
    assert.equal(relativeForMatch('/w/b/x/y.ts', multi), 'x/y.ts');
  });

  it('nested roots: the longest containing root wins', () => {
    const nested = [
      { key: '/w', name: 'outer' },
      { key: '/w/inner', name: 'inner' },
    ];
    assert.equal(relativeForMatch('/w/inner/src/a.ts', nested), 'src/a.ts');
  });

  it('outside every root: the absolute path without its leading slash', () => {
    assert.equal(relativeForMatch('/other/dir/x.ts', roots), 'other/dir/x.ts');
    assert.equal(relativeForMatch('/other/dir/x.ts', []), 'other/dir/x.ts');
  });

  it('a root whose name is a string prefix of a sibling directory does not match it', () => {
    assert.equal(relativeForMatch('/w/proj/x.ts', roots), 'w/proj/x.ts');
  });

  it('Windows keys without a leading slash are returned as-is when outside', () => {
    assert.equal(relativeForMatch('c:/proj/x.ts', []), 'c:/proj/x.ts');
  });

  it('never returns a path with a backslash or a leading slash', () => {
    for (const k of ['/w/p/a.ts', '/q/b.ts', 'c:/x/y.ts']) {
      const r = relativeForMatch(k, roots);
      assert.ok(!r.includes('\\') && !r.startsWith('/'), r);
    }
  });
});
