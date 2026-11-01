import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run, targetsOf } from '../support/analyze';
import { must } from '../support/fixtures';
import { K } from '../../src/core/constants';

const find = (r: Awaited<ReturnType<typeof run>>['result'], key: string) => must(r.targets.find((t) => t.key === key), key);

describe('analyzeReferences: DESIGN 14 counting worked examples', () => {
  const ex1Multi = [
    "import { a, b as bee } from './util';",
    "import * as p from 'node:path';",
    "import './side';",
    'const x = a() + a() + bee(); // a() ignored',
    'const s = "a()";',
  ].join('\n');
  const ex1Single =
    "import { a, b as bee } from './util'; import * as p from 'node:path'; import './side'; const x = a() + a() + bee(); // a() ignored  const s = \"a()\";";
  const ex1Files = { '/ws/util.ts': 'export const a = 1, b = 2;', '/ws/side.ts': 'export {}' };

  for (const [label, text] of [
    ['multi-line', ex1Multi],
    ['the literal single-line form from the design', ex1Single],
  ] as const) {
    it(`(1) TS ${label}: util = 1 statement + 3 usages = 4, side = 1, node:path unresolved`, async () => {
      const { result } = await run(ex1Files, '/ws/main.ts', text);
      assert.equal(result.targets.length, 2);
      const util = find(result, '/ws/util.ts');
      assert.equal(util.statements, 1);
      assert.equal(util.usages, 3);
      assert.equal(util.count, 4);
      assert.deepEqual(util.specifiers, ['./util']);
      const side = find(result, '/ws/side.ts');
      assert.equal(side.statements, 1);
      assert.equal(side.usages, 0);
      assert.equal(side.count, 1);
      assert.equal(result.unresolved, 1);
      assert.equal(result.skipped, undefined);
      assert.equal(result.truncated, false);
      assert.equal(result.language, 'ts');
      assert.equal(result.source, '/ws/main.ts');
      assert.deepEqual(
        result.targets.map((t) => t.key),
        ['/ws/util.ts', '/ws/side.ts'],
        'sorted by count desc',
      );
    });
  }

  it('(1) the util target remembers the line of its import statement', async () => {
    const { result } = await run(ex1Files, '/ws/main.ts', ex1Multi);
    assert.deepEqual(find(result, '/ws/util.ts').lines, [1]);
    assert.deepEqual(find(result, '/ws/side.ts').lines, [3]);
  });

  it('(2) Python: `import pkg.mod as m` + m.f(); m.g() -> 1+2; `from .util import h` + h(); h() -> 1+2', async () => {
    const text = ['import pkg.mod as m', 'm.f(); m.g()', 'from .util import h', 'h(); h()'].join('\n');
    const { result } = await run({ '/ws/pkg/mod.py': 'def f(): pass', '/ws/util.py': 'def h(): pass' }, '/ws/main.py', text);
    const mod = find(result, '/ws/pkg/mod.py');
    assert.deepEqual([mod.statements, mod.usages, mod.count], [1, 2, 3]);
    const util = find(result, '/ws/util.py');
    assert.deepEqual([util.statements, util.usages, util.count], [1, 2, 3]);
    assert.equal(result.targets.length, 2);
    assert.equal(result.language, 'python');
  });

  it('(3) C: `#include "a.h"` twice + `#include <stdio.h>` -> a.h count 2, stdio unresolved', async () => {
    const text = ['#include "a.h"', '#include "a.h"', '#include <stdio.h>'].join('\n');
    const { result } = await run({ '/ws/src/a.h': '' }, '/ws/src/main.c', text);
    assert.equal(result.targets.length, 1);
    const a = find(result, '/ws/src/a.h');
    assert.deepEqual([a.statements, a.usages, a.count], [2, 0, 2]);
    assert.deepEqual(a.lines, [1, 2]);
    assert.equal(result.unresolved, 1);
  });

  it('(4) `import {A}` + `import type {B}` from the same module, A; B; B -> 2 statements + 3 usages = 5', async () => {
    const text = ["import {A} from './m';", "import type {B} from './m';", 'A;', 'B;', 'B;'].join('\n');
    const { result } = await run({ '/ws/m.ts': 'export {}' }, '/ws/main.ts', text);
    assert.equal(result.targets.length, 1);
    const m = find(result, '/ws/m.ts');
    assert.deepEqual([m.statements, m.usages, m.count], [2, 3, 5]);
    assert.deepEqual(m.specifiers, ['./m'], 'identical specifiers are listed once');
  });
});

describe('analyzeReferences: what counts as a statement', () => {
  it('every import form pointing at the same file counts once each (import, export-from, require, dynamic, side-effect, type-only)', async () => {
    const text = [
      "import a from './m';",
      "import './m';",
      "import type { T } from './m';",
      "export * from './m';",
      "export { q } from './m';",
      "const r = require('./m');",
      "const l = import('./m');",
    ].join('\n');
    const { result } = await run({ '/ws/m.ts': '' }, '/ws/main.ts', text);
    const m = find(result, '/ws/m.ts');
    assert.equal(m.statements, 7);
    assert.deepEqual(m.lines, [1, 2, 3, 4, 5, 6, 7]);
  });

  it('usages are counted per distinct binding local, per target, and never mixed between targets', async () => {
    const text = [
      "import foo from './one';",
      "import { bar } from './two';",
      'foo(); foo(); bar();',
      'foo(bar);',
    ].join('\n');
    const { result } = await run({ '/ws/one.ts': '', '/ws/two.ts': '' }, '/ws/main.ts', text);
    assert.equal(find(result, '/ws/one.ts').usages, 3);
    assert.equal(find(result, '/ws/two.ts').usages, 2);
  });

  it('languages without bindings count statements only (C, CSS, HTML, Ruby)', async () => {
    const css = await run({ '/ws/a.css': '' }, '/ws/m.css', '@import "a.css";\n@import "a.css";\na { color: red }');
    assert.equal(find(css.result, '/ws/a.css').count, 2);
    const html = await run({ '/ws/a.png': '' }, '/ws/index.html', '<img src="a.png"><img src="a.png"><p>a.png</p>');
    assert.equal(find(html.result, '/ws/a.png').count, 2);
    const rb = await run({ '/ws/lib/x.rb': '' }, '/ws/lib/main.rb', "require_relative 'x'\nrequire_relative 'x'\nx = X.new");
    assert.equal(find(rb.result, '/ws/lib/x.rb').count, 2);
  });

  it('a name used only in comments and strings is not a usage', async () => {
    const text = ["import { a } from './m';", '// a()', '/* a */', 'const s = "a";', 'const t = `a`;'].join('\n');
    const { result } = await run({ '/ws/m.ts': '' }, '/ws/main.ts', text);
    assert.equal(find(result, '/ws/m.ts').usages, 0);
  });

  it('documented non-modelled behaviours stay as documented (shadowing, object keys count; f-strings do not)', async () => {
    const ts = [
      "import { foo } from './m';",
      'const o = { foo: 1 };',
      'function g(foo) { return foo; }',
    ].join('\n');
    const r1 = await run({ '/ws/m.ts': '' }, '/ws/main.ts', ts);
    assert.equal(find(r1.result, '/ws/m.ts').usages, 3);
    const py = ['from .u import val', 'print(f"{val}")', 'print(val)'].join('\n');
    const r2 = await run({ '/ws/u.py': '' }, '/ws/main.py', py);
    assert.equal(find(r2.result, '/ws/u.py').usages, 1);
  });

  it('import statements themselves are not counted as usages of their own names', async () => {
    const { result } = await run({ '/ws/m.ts': '' }, '/ws/main.ts', "import { a } from './m';\n");
    assert.equal(find(result, '/ws/m.ts').usages, 0);
    assert.equal(find(result, '/ws/m.ts').count, 1);
  });

  it('multi-line import lists are not counted as usages', async () => {
    const text = ["import {", '  alpha,', '  beta as b2,', "} from './m';", 'alpha(); b2();'].join('\n');
    const { result } = await run({ '/ws/m.ts': '' }, '/ws/main.ts', text);
    assert.equal(find(result, '/ws/m.ts').usages, 2);
  });
});

describe('analyzeReferences: target filtering', () => {
  it('self references are dropped', async () => {
    const keys = await targetsOf({}, '/ws/main.ts', "import './main';\nimport * as me from './main.ts';\n");
    assert.deepEqual(keys, []);
  });

  it('circular imports resolve independently in both directions, with no recursion', async () => {
    const a = "import { b } from './b';\nb();";
    const b = "import { a } from './a';\na();";
    const files = { '/ws/a.ts': a, '/ws/b.ts': b };
    assert.deepEqual(await targetsOf(files, '/ws/a.ts', a), ['/ws/b.ts']);
    assert.deepEqual(await targetsOf(files, '/ws/b.ts', b), ['/ws/a.ts']);
  });

  it('anything under a node_modules segment is never a target, even through relative paths', async () => {
    const files = {
      '/ws/node_modules/pkg/index.js': '',
      '/ws/src/node_modules/local/index.ts': '',
      '/ws/lodash.ts': '',
    };
    const text = [
      "import a from '../node_modules/pkg/index.js';",
      "import b from './node_modules/local';",
      "import c from 'lodash';",
      "import d from '../node_modules/pkg';",
    ].join('\n');
    const { result } = await run(files, '/ws/src/main.ts', text);
    assert.deepEqual(result.targets, []);
  });

  it('bare package names never resolve to workspace files with the same name', async () => {
    const files = { '/ws/lodash.ts': '', '/ws/src/react.ts': '', '/ws/src/lodash/index.ts': '' };
    const { result } = await run(files, '/ws/src/main.ts', "import _ from 'lodash';\nimport R from 'react';\n");
    assert.deepEqual(result.targets, []);
    assert.equal(result.unresolved, 2);
  });

  it('targets matching isExcluded are dropped', async () => {
    const files = { '/ws/gen/api.ts': '', '/ws/real.ts': '' };
    const { result } = await run(files, '/ws/main.ts', "import a from './gen/api';\nimport b from './real';\n", {
      isExcluded: (k) => k.includes('/gen/'),
    });
    assert.deepEqual(
      result.targets.map((t) => t.key),
      ['/ws/real.ts'],
    );
  });

  it('missing targets are counted as unresolved, not as errors', async () => {
    const { result } = await run({}, '/ws/main.ts', "import a from './nope';\nimport b from '../also-nope';\n");
    assert.deepEqual(result.targets, []);
    assert.equal(result.unresolved, 2);
    assert.equal(result.skipped, undefined);
  });

  it('results are sorted by count desc, then key asc', async () => {
    const files = { '/ws/a.ts': '', '/ws/b.ts': '', '/ws/c.ts': '' };
    const text = [
      "import './c';",
      "import './b';",
      "import './a';",
      "import './a';",
      "import './c';",
      "import './c';",
    ].join('\n');
    const { result } = await run(files, '/ws/main.ts', text);
    assert.deepEqual(
      result.targets.map((t) => [t.key, t.count]),
      [
        ['/ws/c.ts', 3],
        ['/ws/a.ts', 2],
        ['/ws/b.ts', 1],
      ],
    );
    const tie = await run(files, '/ws/main.ts', "import './c';\nimport './b';\nimport './a';\n");
    assert.deepEqual(
      tie.result.targets.map((t) => t.key),
      ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'],
      'equal counts sort by key ascending',
    );
  });

  it('keeps at most MAX_REFS_PER_SOURCE targets (top by count, then path) and sets truncated', async () => {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < 35; i++) {
      const n = String(i).padStart(2, '0');
      files[`/ws/t${n}.ts`] = '';
      lines.push(`import './t${n}';`);
    }
    lines.push("import './t34';", "import './t34';", "import './t33';"); // t34 count 3, t33 count 2
    const { result } = await run(files, '/ws/main.ts', lines.join('\n'));
    assert.equal(result.targets.length, K.MAX_REFS_PER_SOURCE);
    assert.equal(result.truncated, true);
    assert.equal(must(result.targets[0]).key, '/ws/t34.ts');
    assert.equal(must(result.targets[1]).key, '/ws/t33.ts');
    const keys = result.targets.map((t) => t.key);
    assert.ok(keys.includes('/ws/t00.ts'), 'ties are broken by key ascending, so the lowest keys survive');
    assert.ok(!keys.includes('/ws/t32.ts') || keys.length === 30);
    assert.ok(!keys.includes('/ws/t31.ts'), 'a count-1 file with a high key is the first to be cut');
  });

  it('MAX_REFS_PER_SOURCE + 1 targets is truncated to exactly MAX_REFS_PER_SOURCE (off-by-one guard)', async () => {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < K.MAX_REFS_PER_SOURCE + 1; i++) {
      files[`/ws/t${String(i).padStart(2, '0')}.ts`] = '';
      lines.push(`import './t${String(i).padStart(2, '0')}';`);
    }
    const { result } = await run(files, '/ws/main.ts', lines.join('\n'));
    assert.equal(result.targets.length, K.MAX_REFS_PER_SOURCE);
    assert.equal(result.truncated, true);
  });

  it('exactly MAX_REFS_PER_SOURCE targets is not truncated', async () => {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < K.MAX_REFS_PER_SOURCE; i++) {
      files[`/ws/t${i}.ts`] = '';
      lines.push(`import './t${i}';`);
    }
    const { result } = await run(files, '/ws/main.ts', lines.join('\n'));
    assert.equal(result.targets.length, K.MAX_REFS_PER_SOURCE);
    assert.equal(result.truncated, false);
  });
});

describe('analyzeReferences: Windows paths and files outside the workspace', () => {
  it('drive-letter keys: a.ts importing ./b resolves to c:/ws/src/b.ts', async () => {
    const keys = await targetsOf({ 'c:/ws/src/b.ts': '' }, 'c:/ws/src/a.ts', "import b from './b';", { roots: ['c:/ws'] });
    assert.deepEqual(keys, ['c:/ws/src/b.ts']);
  });

  it('backslashes inside specifiers are normalised', async () => {
    const files = { 'c:/ws/src/sub/b.ts': '', '/ws/src/sub/b.ts': '' };
    assert.deepEqual(await targetsOf(files, 'c:/ws/src/a.ts', "import b from '.\\\\sub\\\\b';", { roots: ['c:/ws'] }), ['c:/ws/src/sub/b.ts']);
    assert.deepEqual(await targetsOf(files, '/ws/src/a.ts', "import b from '.\\\\sub\\\\b';"), ['/ws/src/sub/b.ts']);
  });

  it('".." climbing never escapes the root and does not throw', async () => {
    const keys = await targetsOf({}, '/a.ts', "import x from '../../../../../x';");
    assert.deepEqual(keys, []);
  });

  it('UNC keys', async () => {
    const keys = await targetsOf({ '//srv/share/p/b.ts': '' }, '//srv/share/p/a.ts', "import b from './b';", { roots: ['//srv/share'] });
    assert.deepEqual(keys, ['//srv/share/p/b.ts']);
  });

  it('a file outside the workspace resolves its neighbours when roots = [dirname(file)]', async () => {
    const files = { '/elsewhere/proj/b.ts': '', '/elsewhere/proj/sub/c.ts': '' };
    const text = "import b from './b';\nimport c from '/sub/c';\nimport d from './missing';";
    const { result } = await run(files, '/elsewhere/proj/a.ts', text, { roots: ['/elsewhere/proj'] });
    assert.deepEqual(result.targets.map((t) => t.key).sort(), ['/elsewhere/proj/b.ts', '/elsewhere/proj/sub/c.ts']);
    assert.equal(result.unresolved, 1);
  });
});

describe('analyzeReferences: skipped files and robustness', () => {
  it('unsupported languages are skipped', async () => {
    const { result } = await run({}, '/ws/notes.txt', "import './x'");
    assert.equal(result.skipped, 'unsupported-language');
    assert.equal(result.language, undefined);
    assert.deepEqual(result.targets, []);
  });

  it('too-large: strictly more than maxFileSizeKb*1024 characters, decided before any scanning or fs access', async () => {
    const pad = (n: number): string => 'x'.repeat(n);
    const atLimit = await run({}, '/ws/a.ts', pad(1024), { maxFileSizeKb: 1 });
    assert.equal(atLimit.result.skipped, undefined);
    const over = await run({ '/ws/b.ts': '' }, '/ws/a.ts', "import './b';" + pad(1024), { maxFileSizeKb: 1 });
    assert.equal(over.result.skipped, 'too-large');
    assert.deepEqual(over.result.targets, []);
    assert.equal(over.analyzeCalls, 0, 'no file-system access at all for a skipped file');
  });

  it('default size limit is 512 KB', async () => {
    const big = "import './b';\n" + 'a'.repeat(512 * 1024);
    const { result } = await run({ '/ws/b.ts': '' }, '/ws/a.ts', big);
    assert.equal(result.skipped, 'too-large');
    const justUnder = "import './b';\n" + 'a'.repeat(512 * 1024 - 14);
    const ok = await run({ '/ws/b.ts': '' }, '/ws/a.ts', justUnder);
    assert.equal(ok.result.skipped, undefined);
  });

  it('binary: NUL within the first 8000 characters', async () => {
    const early = await run({ '/ws/b.ts': '' }, '/ws/a.ts', "import './b';\n" + '\u0000' + 'x');
    assert.equal(early.result.skipped, 'binary');
    assert.deepEqual(early.result.targets, []);
    const edge = await run({}, '/ws/a.ts', 'a'.repeat(7999) + '\u0000');
    assert.equal(edge.result.skipped, 'binary', 'index 7999 is inside the first 8000 characters');
    const late = await run({ '/ws/b.ts': '' }, '/ws/a.ts', "import './b';\n" + 'a'.repeat(8100) + '\u0000');
    assert.equal(late.result.skipped, undefined, 'a NUL after the first 8000 characters is not treated as binary');
  });

  it('an excluded source file is skipped', async () => {
    const { result } = await run({ '/ws/b.ts': '' }, '/ws/dist/a.ts', "import './b';", { isExcluded: (k) => k.includes('/dist/') });
    assert.equal(result.skipped, 'excluded');
    assert.deepEqual(result.targets, []);
  });

  it('empty file: no targets, nothing skipped', async () => {
    const { result } = await run({}, '/ws/a.ts', '');
    assert.deepEqual(result.targets, []);
    assert.equal(result.skipped, undefined);
    assert.equal(result.unresolved, 0);
  });

  it('never rejects when the file system throws or rejects; failed probes count as unresolved', async () => {
    const text = "import './b';\nimport './c';\n";
    for (const fsOptions of [
      { throwOn: ['isFile', 'listDir', 'readText'] as const },
      { rejectOn: ['isFile', 'listDir', 'readText'] as const },
    ]) {
      const { result } = await run({ '/ws/b.ts': '', '/ws/c.ts': '' }, '/ws/a.ts', text, { fsOptions: { ...fsOptions } }).catch((e: unknown) => {
        assert.fail(`analysis rejected: ${String(e)}`);
      });
      assert.deepEqual(result.targets, []);
      assert.equal(result.unresolved, 2);
    }
  });

  it('parseMs is a finite non-negative number', async () => {
    const { result } = await run({}, '/ws/a.ts', "import './b';");
    assert.ok(Number.isFinite(result.parseMs) && result.parseMs >= 0);
  });

  it('is deterministic and does not mutate shared state: two runs give identical results', async () => {
    const files = { '/ws/m.ts': '', '/ws/n.ts': '' };
    const text = "import { a } from './m';\nimport './n';\na();";
    const r1 = await run(files, '/ws/a.ts', text);
    const r2 = await run(files, '/ws/a.ts', text);
    assert.deepEqual({ ...r1.result, parseMs: 0 }, { ...r2.result, parseMs: 0 });
  });

  it('a hostile source (token soup, lots of braces) cannot make analysis throw', async () => {
    const soup = "import { { { from '; import ' \"\" `${ ${ `\n/* import 'x' require( require(`import(`";
    await assert.doesNotReject(run({}, '/ws/a.ts', soup));
  });

  it('the cooperative deadline stops resolving once ANALYSIS_TIMEOUT_MS has passed', async () => {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      files[`/ws/f${i}.ts`] = '';
      lines.push(`import './f${i}';`);
    }
    const text = lines.join('\n');
    const normal = await run(files, '/ws/a.ts', text);
    assert.equal(normal.result.targets.length, K.MAX_REFS_PER_SOURCE);
    let t = 0;
    const slow = await run(files, '/ws/a.ts', text, {
      now: () => {
        t += K.ANALYSIS_TIMEOUT_MS; // every look at the clock burns a whole budget
        return t;
      },
    });
    assert.ok(slow.result.targets.length < normal.result.targets.length, `stopped early: ${slow.result.targets.length} < ${normal.result.targets.length}`);
  });

  it('probe budget: a flood of missing imports stops probing at MAX_PROBES (no unbounded fs traffic)', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `import './missing${i}';`);
    const { analyzeCalls, result } = await run({}, '/ws/a.ts', lines.join('\n'));
    assert.deepEqual(result.targets, []);
    assert.ok(analyzeCalls <= K.MAX_PROBES, `${analyzeCalls} fs probes for 300 missing imports (budget ${K.MAX_PROBES})`);
    assert.ok(result.unresolved >= 1);
  });
});
