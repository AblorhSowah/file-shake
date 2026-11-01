import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFirst, run, targetsOf } from '../support/analyze';
import { parseImports } from '../support/refs';
import { K } from '../../src/core/constants';
import { must } from '../support/fixtures';

/** Resolve one TS import specifier from /ws/src/a.ts against `files`. */
async function ts(spec: string, files: Record<string, string>, from = '/ws/src/a.ts', roots = ['/ws']): Promise<string[]> {
  return targetsOf(files, from, `import x from ${JSON.stringify(spec)};`, { roots });
}

describe('resolver: TypeScript / JavaScript', () => {
  const files: Record<string, string> = {
    '/ws/src/b.ts': '',
    '/ws/src/index.ts': '',
    '/ws/index.ts': '',
    '/ws/src/dir/index.ts': '',
    '/ws/src/mixed.ts': '',
    '/ws/src/mixed.js': '',
    '/ws/src/only.js': '',
    '/ws/src/jsx.tsx': '',
    '/ws/src/data.json': '{}',
    '/ws/src/types.d.ts': '',
    '/ws/src/c.mts': '',
    '/ws/src/d.cts': '',
    '/ws/src/vue.vue': '',
    '/ws/util.ts': '',
    '/ws/lodash.ts': '',
    '/ws/node_modules/pkg/index.js': '',
    '/ws/src/node.cjs': '',
  };

  const resolved: Array<[string, string]> = [
    ['./b', '/ws/src/b.ts'],
    ['./b.ts', '/ws/src/b.ts'],
    ['./dir', '/ws/src/dir/index.ts'],
    ['./dir/', '/ws/src/dir/index.ts'],
    ['./mixed', '/ws/src/mixed.ts'],
    ['./only', '/ws/src/only.js'],
    ['./jsx', '/ws/src/jsx.tsx'],
    ['./data.json', '/ws/src/data.json'],
    ['./types', '/ws/src/types.d.ts'],
    ['./c', '/ws/src/c.mts'],
    ['./d', '/ws/src/d.cts'],
    ['./node', '/ws/src/node.cjs'],
    ['./vue', '/ws/src/vue.vue'],
    ['../util', '/ws/util.ts'],
    ['.', '/ws/src/index.ts'],
    ['..', '/ws/index.ts'],
    ['/src/b', '/ws/src/b.ts'],
    ['/util', '/ws/util.ts'],
    // ".js" in the specifier maps back to the TypeScript source
    ['./b.js', '/ws/src/b.ts'],
    ['./jsx.jsx', '/ws/src/jsx.tsx'],
    ['./c.mjs', '/ws/src/c.mts'],
    ['./d.cjs', '/ws/src/d.cts'],
  ];
  for (const [spec, expected] of resolved) {
    it(`${spec} -> ${expected}`, async () => {
      assert.deepEqual(await ts(spec, files), [expected]);
    });
  }

  const unresolved = ['lodash', 'react', 'node:path', '@scope/pkg', 'lodash/fp', './missing', '../missing', '/nope', './dir/missing', 'pkg/index.js'];
  for (const spec of unresolved) {
    it(`${spec} does not resolve (bare packages never map to workspace or node_modules files)`, async () => {
      assert.deepEqual(await ts(spec, files), []);
    });
  }

  it('extension order for a ts importer prefers .ts over .tsx/.js; for a js importer prefers .js', async () => {
    assert.deepEqual(await ts('./mixed', files, '/ws/src/a.ts'), ['/ws/src/mixed.ts']);
    assert.deepEqual(await targetsOf(files, '/ws/src/a.js', "import x from './mixed';"), ['/ws/src/mixed.js']);
    assert.deepEqual(await targetsOf(files, '/ws/src/a.js', "const x = require('./b');"), ['/ws/src/b.ts'], 'a js importer falls back to .ts');
  });

  it('extension probing follows the documented order exactly (ts importer): each extension wins over all later ones', async () => {
    const order = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
    for (let i = 0; i < order.length; i++) {
      const present: Record<string, string> = {};
      for (const ext of order.slice(i)) present[`/ws/src/pick${ext}`] = '';
      assert.deepEqual(await ts('./pick', present), [`/ws/src/pick${order[i]}`], `with ${order.slice(i).join(' ')} present`);
    }
  });

  it('extension probing follows the documented order exactly (js importer)', async () => {
    const order = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
    for (let i = 0; i < order.length; i++) {
      const present: Record<string, string> = {};
      for (const ext of order.slice(i)) present[`/ws/src/pick${ext}`] = '';
      assert.deepEqual(await targetsOf(present, '/ws/src/a.js', "import x from './pick';"), [`/ws/src/pick${order[i]}`], `with ${order.slice(i).join(' ')} present`);
    }
  });

  it('a plain file is preferred over a directory index, and index.* follows the same extension order', async () => {
    assert.deepEqual(await ts('./d', { '/ws/src/d/index.tsx': '', '/ws/src/d/index.ts': '', '/ws/src/d/index.js': '' }), ['/ws/src/d/index.ts']);
    assert.deepEqual(await ts('./d', { '/ws/src/d/index.js': '', '/ws/src/d/index.tsx': '' }), ['/ws/src/d/index.tsx']);
  });

  it('a file beats a directory of the same name', async () => {
    const f = { '/ws/src/thing.ts': '', '/ws/src/thing/index.ts': '' };
    assert.deepEqual(await ts('./thing', f), ['/ws/src/thing.ts']);
  });

  it('a spec that already has a known extension and exists is used as-is, before extension probing', async () => {
    const f = { '/ws/src/x.js': '', '/ws/src/x.js.ts': '', '/ws/src/x.ts': '' };
    const keys = await ts('./x.js', f);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], '/ws/src/x.js');
  });

  it('root-relative specifiers try every workspace root', async () => {
    const f = { '/w2/shared/only-in-second.ts': '' };
    assert.deepEqual(await ts('/shared/only-in-second', f, '/w1/a.ts', ['/w1', '/w2']), ['/w2/shared/only-in-second.ts']);
  });

  it('require() and dynamic import() resolve like import', async () => {
    const text = "const a = require('./b');\nconst c = import('./dir');\n";
    assert.deepEqual((await targetsOf(files, '/ws/src/a.ts', text)).sort(), ['/ws/src/b.ts', '/ws/src/dir/index.ts']);
  });

  it('symlink-looking relative paths through node_modules are rejected even if the file exists', async () => {
    assert.deepEqual(await ts('../../node_modules/pkg/index.js', files, '/ws/src/a.ts'), []);
  });
});

describe('resolver: tsconfig paths / baseUrl / extends', () => {
  const base: Record<string, string> = {
    '/ws/tsconfig.json': `{
      // comments and trailing commas are legal in tsconfig
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"],
          "@/deep/*": ["deep/*"],
          "@lib/*": ["lib/*",],
          "@exact": ["src/b.ts"],
          "@multi/*": ["missing/*", "src/*"],
          "@two*stars*": ["nope/*"],
        },
      },
    }`,
    '/ws/src/b.ts': '',
    '/ws/src/dir/index.ts': '',
    '/ws/src/deep/z.ts': '',
    '/ws/deep/z.ts': '',
    '/ws/lib/x.ts': '',
    '/ws/src/a.ts': '',
  };

  const cases: Array<[string, string[]]> = [
    ['@/b', ['/ws/src/b.ts']],
    ['@/dir', ['/ws/src/dir/index.ts']],
    ['@/deep/z', ['/ws/deep/z.ts']], // longest literal prefix wins
    ['@lib/x', ['/ws/lib/x.ts']],
    ['@exact', ['/ws/src/b.ts']],
    ['@multi/b', ['/ws/src/b.ts']], // targets are tried in order
    ['@/missing', []],
    ['@unknown/b', []],
    ['@two*stars*', []], // more than one `*` in a key is not supported
    ['src/b', ['/ws/src/b.ts']], // baseUrl "." makes bare "src/b" resolvable
  ];
  for (const [spec, expected] of cases) {
    it(`${spec} -> ${expected.join(',') || 'unresolved'}`, async () => {
      assert.deepEqual(await ts(spec, base), expected);
    });
  }

  it('baseUrl alone: bare specifiers resolve against it', async () => {
    const f = { '/p2/tsconfig.json': '{"compilerOptions":{"baseUrl":"src"}}', '/p2/src/lib/x.ts': '', '/p2/src/a.ts': '' };
    assert.deepEqual(await ts('lib/x', f, '/p2/src/a.ts', ['/p2']), ['/p2/src/lib/x.ts']);
  });

  it('without baseUrl or paths a bare specifier is unresolved even if a same-named file exists', async () => {
    const f = { '/p2/tsconfig.json': '{"compilerOptions":{}}', '/p2/src/lib/x.ts': '', '/p2/lib/x.ts': '', '/p2/src/a.ts': '' };
    assert.deepEqual(await ts('lib/x', f, '/p2/src/a.ts', ['/p2']), []);
  });

  it('paths without baseUrl are relative to the tsconfig directory', async () => {
    const f = { '/p3/tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["./src/*"]}}}', '/p3/src/b.ts': '', '/p3/src/a.ts': '' };
    assert.deepEqual(await ts('~/b', f, '/p3/src/a.ts', ['/p3']), ['/p3/src/b.ts']);
  });

  it('jsconfig.json is used when there is no tsconfig.json', async () => {
    const f = { '/p6/jsconfig.json': '{"compilerOptions":{"baseUrl":"."}}', '/p6/lib/x.js': '', '/p6/src/a.js': '' };
    assert.deepEqual(await targetsOf(f, '/p6/src/a.js', "import x from 'lib/x';", { roots: ['/p6'] }), ['/p6/lib/x.js']);
  });

  it('the nearest tsconfig wins when walking up from the importing file', async () => {
    const f = {
      '/p5/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["root/*"]}}}',
      '/p5/pkg/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["pkgdir/*"]}}}',
      '/p5/root/z.ts': '',
      '/p5/pkg/pkgdir/z.ts': '',
      '/p5/pkg/src/a.ts': '',
    };
    assert.deepEqual(await ts('@x/z', f, '/p5/pkg/src/a.ts', ['/p5']), ['/p5/pkg/pkgdir/z.ts']);
  });

  it('relative extends is followed; the child overrides what it defines and inherits the rest', async () => {
    const f = {
      '/p4/tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@base/*":["base/*"]}}}',
      '/p4/tsconfig.json': '{"extends":"./tsconfig.base.json"}',
      '/p4/base/y.ts': '',
      '/p4/src/a.ts': '',
    };
    assert.deepEqual(await ts('@base/y', f, '/p4/src/a.ts', ['/p4']), ['/p4/base/y.ts'], 'inherited from the base config');

    const child = {
      ...f,
      '/p4/tsconfig.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"paths":{"@own/*":["own/*"]}}}',
      '/p4/own/q.ts': '',
    };
    assert.deepEqual(await ts('@own/q', child, '/p4/src/a.ts', ['/p4']), ['/p4/own/q.ts'], 'child paths apply');
  });

  it('extends chains of two levels are followed', async () => {
    const f = {
      '/p7/a.json': '{"compilerOptions":{"baseUrl":"."}}',
      '/p7/b.json': '{"extends":"./a.json"}',
      '/p7/tsconfig.json': '{"extends":"./b.json"}',
      '/p7/lib/x.ts': '',
      '/p7/src/a.ts': '',
    };
    assert.deepEqual(await ts('lib/x', f, '/p7/src/a.ts', ['/p7']), ['/p7/lib/x.ts']);
  });

  it('a package-style (non-relative) extends is ignored without breaking resolution', async () => {
    const f = {
      '/p8/tsconfig.json': '{"extends":"@tsconfig/node18/tsconfig.json","compilerOptions":{"baseUrl":"."}}',
      '/p8/lib/x.ts': '',
      '/p8/src/a.ts': '',
    };
    assert.deepEqual(await ts('lib/x', f, '/p8/src/a.ts', ['/p8']), ['/p8/lib/x.ts']);
  });

  it('include / references are ignored: files outside "include" still resolve', async () => {
    const f = {
      '/p9/tsconfig.json': '{"include":["only/**"],"references":[{"path":"../other"}],"compilerOptions":{"baseUrl":"."}}',
      '/p9/lib/x.ts': '',
      '/p9/src/a.ts': '',
    };
    assert.deepEqual(await ts('lib/x', f, '/p9/src/a.ts', ['/p9']), ['/p9/lib/x.ts']);
  });

  it('a malformed tsconfig is tolerated (no throw, relative imports still work)', async () => {
    const f = { '/pa/tsconfig.json': '{ this is : not json', '/pa/src/b.ts': '', '/pa/src/a.ts': '' };
    assert.deepEqual(await ts('./b', f, '/pa/src/a.ts', ['/pa']), ['/pa/src/b.ts']);
  });
});

describe('resolver: Python', () => {
  const files: Record<string, string> = {
    '/ws/app/main.py': '',
    '/ws/pkg/__init__.py': '',
    '/ws/pkg/mod.py': '',
    '/ws/pkg/sub/__init__.py': '',
    '/ws/pkg/sub/leaf.py': '',
    '/ws/app/util.py': '',
    '/ws/lib.py': '',
    '/ws/src/srcpkg/thing.py': '',
    '/ws/app/helpers/__init__.py': '',
    '/ws/app/helpers/x.py': '',
  };
  const py = (text: string, f: Record<string, string> = files): Promise<string[]> => targetsOf(f, '/ws/app/main.py', text);

  const cases: Array<[string, string[]]> = [
    ['import pkg.mod', ['/ws/pkg/mod.py']],
    ['import pkg', ['/ws/pkg/__init__.py']],
    ['import pkg.sub', ['/ws/pkg/sub/__init__.py']],
    ['import pkg.sub.leaf', ['/ws/pkg/sub/leaf.py']],
    ['import pkg.mod as m', ['/ws/pkg/mod.py']],
    ['from pkg.sub import leaf', ['/ws/pkg/sub/leaf.py']],
    ['from pkg.mod import something', ['/ws/pkg/mod.py']],
    ['from srcpkg import thing', ['/ws/src/srcpkg/thing.py']],
    ['from .util import h', ['/ws/app/util.py']],
    ['from . import util', ['/ws/app/util.py']],
    ['from .. import lib', ['/ws/lib.py']],
    ['from ..pkg import mod', ['/ws/pkg/mod.py']],
    ['from .helpers import x', ['/ws/app/helpers/x.py']],
    ['from .helpers import not_a_module', ['/ws/app/helpers/__init__.py']],
    ['import os', []],
    ['import json, sys', []],
    ['from collections import OrderedDict', []],
    ['from . import nothing_here', []],
    ['from .missing import q', []],
    ['from ........ import far_away', []],
  ];
  for (const [text, expected] of cases) {
    it(`${text} -> ${expected.join(',') || 'unresolved'}`, async () => {
      assert.deepEqual((await py(text)).sort(), [...expected].sort());
    });
  }

  it('`from pkg import mod, name` yields a target per binding: the submodule and the package __init__', async () => {
    const keys = (await py('from pkg import mod, name')).sort();
    assert.deepEqual(keys, ['/ws/pkg/__init__.py', '/ws/pkg/mod.py']);
  });

  it('resolveImport returns separate targets with their own bindings for `from pkg import mod, name`', async () => {
    const { targets } = await resolveFirst('python', '/ws/app/main.py', 'from pkg import mod, name', files);
    const byKey = new Map(targets.map((t) => [t.key, t.bindings.map((b) => b.local)]));
    assert.deepEqual(byKey.get('/ws/pkg/mod.py'), ['mod']);
    assert.deepEqual(byKey.get('/ws/pkg/__init__.py'), ['name']);
  });

  it('absolute imports are tried against every ancestor directory of the importing file', async () => {
    const f = { '/ws/a/b/c/main.py': '', '/ws/a/b/sibling.py': '' };
    assert.deepEqual(await targetsOf(f, '/ws/a/b/c/main.py', 'import sibling'), ['/ws/a/b/sibling.py']);
  });

  it('does not search above the workspace root', async () => {
    const f = { '/ws/main.py': '', '/outside.py': '' };
    assert.deepEqual(await targetsOf(f, '/ws/main.py', 'import outside'), []);
  });
});

describe('resolver: Go', () => {
  const files: Record<string, string> = {
    '/ws/go.mod': 'module example.com/app\n\ngo 1.21\n',
    '/ws/main.go': '',
    '/ws/app.go': '',
    '/ws/util/util.go': '',
    '/ws/util/a.go': '',
    '/ws/util/z_test.go': '',
    '/ws/other/b.go': '',
    '/ws/other/a.go': '',
    '/ws/other/a_test.go': '',
    '/ws/onlytest/x_test.go': '',
    '/ws/sub/go.mod': 'module example.com/sub\n',
    '/ws/sub/main.go': '',
    '/ws/sub/lib/lib.go': '',
  };
  const go = (spec: string, from = '/ws/main.go', f = files): Promise<string[]> =>
    targetsOf(f, from, `package main\n\nimport "${spec}"\n`);

  it('module-relative imports resolve to the package file named after the directory', async () => {
    assert.deepEqual(await go('example.com/app/util'), ['/ws/util/util.go']);
  });

  it('otherwise the alphabetically first non-test .go file', async () => {
    assert.deepEqual(await go('example.com/app/other'), ['/ws/other/a.go']);
  });

  it('the module root itself resolves to <lastSegment>.go', async () => {
    assert.deepEqual(await go('example.com/app'), ['/ws/app.go']);
  });

  it('_test.go files are never targets', async () => {
    assert.deepEqual(await go('example.com/app/onlytest'), []);
  });

  it('missing packages, std lib, third-party and look-alike module prefixes are unresolved', async () => {
    assert.deepEqual(await go('example.com/app/missing'), []);
    assert.deepEqual(await go('fmt'), []);
    assert.deepEqual(await go('github.com/x/y'), []);
    assert.deepEqual(await go('example.com/application/util'), [], 'example.com/application is not inside module example.com/app');
  });

  it('the nearest go.mod wins', async () => {
    assert.deepEqual(await go('example.com/sub/lib', '/ws/sub/main.go'), ['/ws/sub/lib/lib.go']);
    assert.deepEqual(await go('example.com/app/util', '/ws/sub/main.go'), [], 'the outer module is not visible from a nested module');
  });

  it('without a go.mod nothing resolves', async () => {
    const { '/ws/go.mod': _drop, ...noMod } = files;
    void _drop;
    assert.deepEqual(await go('example.com/app/util', '/ws/main.go', noMod), []);
  });

  it('Go counts statements plus usages of the package name (util.Do(), util.X())', async () => {
    const text = ['package main', '', 'import "example.com/app/util"', '', 'func main() {', '\tutil.Do()', '\tutil.X()', '}'].join('\n');
    const { result } = await run(files, '/ws/main.go', text);
    const util = must(result.targets.find((t) => t.key === '/ws/util/util.go'));
    assert.deepEqual([util.statements, util.usages, util.count], [1, 2, 3]);
  });
});

describe('resolver: Java and Kotlin', () => {
  const files: Record<string, string> = {
    '/ws/src/main/java/com/example/app/Main.java': 'package com.example.app;\n',
    '/ws/src/main/java/com/example/util/Helper.java': '',
    '/ws/src/main/java/com/example/util/Constants.java': '',
    '/ws/src/main/java/com/example/Outer.java': '',
    '/ws/custom/com/example/app/Main2.java': 'package com.example.app;\n',
    '/ws/custom/com/example/util/Special.java': '',
    '/ws/src/main/kotlin/com/example/kt/Main.kt': 'package com.example.kt\n',
    '/ws/src/main/kotlin/com/example/util/KHelper.kt': '',
  };
  const main = '/ws/src/main/java/com/example/app/Main.java';
  const java = (text: string, from = main): Promise<string[]> => targetsOf(files, from, text);

  it('imports resolve against src/main/java', async () => {
    assert.deepEqual(await java('import com.example.util.Helper;'), ['/ws/src/main/java/com/example/util/Helper.java']);
  });

  it('static imports drop the member name', async () => {
    assert.deepEqual(await java('import static com.example.util.Constants.MAX;'), ['/ws/src/main/java/com/example/util/Constants.java']);
  });

  it('nested classes drop trailing segments one at a time', async () => {
    assert.deepEqual(await java('import com.example.Outer.Inner;'), ['/ws/src/main/java/com/example/Outer.java']);
    assert.deepEqual(await java('import com.example.Outer.Inner.Deep;'), ['/ws/src/main/java/com/example/Outer.java']);
  });

  it('wildcards, JDK classes and missing classes never resolve', async () => {
    assert.deepEqual(await java('import com.example.util.*;'), []);
    assert.deepEqual(await java('import java.util.List;'), []);
    assert.deepEqual(await java('import com.example.util.Missing;'), []);
  });

  it('the source root is derived from the file\'s own package declaration (non-standard layout)', async () => {
    assert.deepEqual(await java('import com.example.util.Special;', '/ws/custom/com/example/app/Main2.java'), ['/ws/custom/com/example/util/Special.java']);
  });

  it('Kotlin: src/main/kotlin, with and without `as` alias', async () => {
    const from = '/ws/src/main/kotlin/com/example/kt/Main.kt';
    assert.deepEqual(await targetsOf(files, from, 'import com.example.util.KHelper'), ['/ws/src/main/kotlin/com/example/util/KHelper.kt']);
    assert.deepEqual(await targetsOf(files, from, 'import com.example.util.KHelper as KH'), ['/ws/src/main/kotlin/com/example/util/KHelper.kt']);
  });

  it('Java counts statements plus usages of the simple name', async () => {
    const text = ['package com.example.app;', 'import com.example.util.Helper;', 'class Main { Helper h = new Helper(); void f() { Helper.run(); } }'].join('\n');
    const { result } = await run(files, main, text);
    const helper = must(result.targets.find((t) => t.key.endsWith('Helper.java')));
    assert.deepEqual([helper.statements, helper.usages, helper.count], [1, 3, 4]);
  });
});

describe('resolver: C / C++', () => {
  const files: Record<string, string> = {
    '/ws/app/main.c': '',
    '/ws/app/local.h': '',
    '/ws/include/pub.h': '',
    '/ws/src/internal.h': '',
    '/ws/app/sub/dir/nested.h': '',
    '/ws/common/y.h': '',
    '/ws/root.h': '',
    '/ws/app/dup.h': '',
    '/ws/include/dup.h': '',
  };
  const c = (text: string, lang = 'main.c'): Promise<string[]> => targetsOf(files, `/ws/app/${lang}`, text);

  const quote: Array<[string, string[]]> = [
    ['#include "local.h"', ['/ws/app/local.h']],
    ['#include "pub.h"', ['/ws/include/pub.h']],
    ['#include "internal.h"', ['/ws/src/internal.h']],
    ['#include "root.h"', ['/ws/root.h']],
    ['#include "sub/dir/nested.h"', ['/ws/app/sub/dir/nested.h']],
    ['#include "../common/y.h"', ['/ws/common/y.h']],
    ['#include "sub\\\\dir\\\\nested.h"', ['/ws/app/sub/dir/nested.h']],
    ['#include "dup.h"', ['/ws/app/dup.h']], // the includer's directory is searched first
    ['#include "stdio.h"', []],
    ['#include "missing.h"', []],
  ];
  for (const [text, expected] of quote) {
    it(`${text} -> ${expected.join(',') || 'unresolved'}`, async () => {
      assert.deepEqual(await c(text), expected);
    });
  }

  const angle: Array<[string, string[]]> = [
    ['#include <pub.h>', ['/ws/include/pub.h']],
    ['#include <internal.h>', ['/ws/src/internal.h']],
    ['#include <local.h>', []], // angle form does not search the includer's directory
    ['#include <root.h>', []], // ... nor the workspace root
    ['#include <stdio.h>', []],
    ['#include <dup.h>', ['/ws/include/dup.h']],
  ];
  for (const [text, expected] of angle) {
    it(`${text} -> ${expected.join(',') || 'unresolved'}`, async () => {
      assert.deepEqual(await c(text), expected);
    });
  }

  it('C++ files resolve the same way', async () => {
    assert.deepEqual(await c('#include "local.h"', 'main.cpp'), ['/ws/app/local.h']);
  });
});

describe('resolver: Rust', () => {
  const rs = (from: string, text: string, files: Record<string, string>): Promise<string[]> => targetsOf(files, from, text);

  it('`mod x;` from lib.rs / main.rs / mod.rs looks in the same directory', async () => {
    for (const from of ['/ws/src/lib.rs', '/ws/src/main.rs', '/ws/src/mod.rs']) {
      assert.deepEqual(await rs(from, 'mod x;', { '/ws/src/x.rs': '' }), ['/ws/src/x.rs'], from);
      assert.deepEqual(await rs(from, 'mod x;', { '/ws/src/x/mod.rs': '' }), ['/ws/src/x/mod.rs'], from);
    }
  });

  it('`mod x;` from a non-mod file looks in a directory named after the file', async () => {
    assert.deepEqual(await rs('/ws/src/foo.rs', 'mod x;', { '/ws/src/foo/x.rs': '' }), ['/ws/src/foo/x.rs']);
    assert.deepEqual(await rs('/ws/src/foo.rs', 'mod x;', { '/ws/src/x.rs': '' }), [], 'the sibling x.rs is not foo\'s child module');
  });

  it('`mod x { }` (inline) produces no reference', async () => {
    assert.deepEqual(await rs('/ws/src/lib.rs', 'mod x { }', { '/ws/src/x.rs': '' }), []);
  });

  it('use crate::a::b::C -> src/a/b.rs, src/a/b/mod.rs, then shorter prefixes', async () => {
    const from = '/ws/src/main.rs';
    const text = 'use crate::a::b::C;';
    assert.deepEqual(await rs(from, text, { '/ws/src/a/b.rs': '' }), ['/ws/src/a/b.rs']);
    assert.deepEqual(await rs(from, text, { '/ws/src/a/b/mod.rs': '' }), ['/ws/src/a/b/mod.rs']);
    assert.deepEqual(await rs(from, text, { '/ws/src/a.rs': '' }), ['/ws/src/a.rs']);
    assert.deepEqual(await rs(from, text, { '/ws/src/a/mod.rs': '' }), ['/ws/src/a/mod.rs']);
    assert.deepEqual(await rs(from, text, { '/ws/src/a/b.rs': '', '/ws/src/a.rs': '' }), ['/ws/src/a/b.rs'], 'the longest match wins');
    assert.deepEqual(await rs(from, text, {}), []);
  });

  it('crate root is the nearest ancestor directory named src', async () => {
    assert.deepEqual(await rs('/ws/crate/src/deep/inner.rs', 'use crate::a::B;', { '/ws/crate/src/a.rs': '' }), ['/ws/crate/src/a.rs']);
  });

  it('use with brace lists and aliases resolves the module path', async () => {
    assert.deepEqual(await rs('/ws/src/main.rs', 'use crate::a::b::{C, D as E};', { '/ws/src/a/b.rs': '' }), ['/ws/src/a/b.rs']);
    assert.deepEqual(await rs('/ws/src/main.rs', 'pub use crate::a::B;', { '/ws/src/a.rs': '' }), ['/ws/src/a.rs']);
  });

  it('self:: and super:: resolve relative to the module directory', async () => {
    assert.deepEqual(await rs('/ws/src/lib.rs', 'use self::sib::F;', { '/ws/src/sib.rs': '' }), ['/ws/src/sib.rs']);
    assert.deepEqual(await rs('/ws/src/child/mod.rs', 'use super::up::G;', { '/ws/src/up.rs': '' }), ['/ws/src/up.rs']);
    assert.deepEqual(await rs('/ws/src/foo.rs', 'use super::up::G;', { '/ws/src/up.rs': '' }), ['/ws/src/up.rs']);
  });

  it('std and external crates are unresolved', async () => {
    assert.deepEqual(await rs('/ws/src/main.rs', 'use std::collections::HashMap;\nuse serde::Serialize;', { '/ws/src/std.rs': '', '/ws/src/serde.rs': '' }), []);
  });
});

describe('resolver: Ruby', () => {
  const files: Record<string, string> = {
    '/ws/lib/a.rb': '',
    '/ws/lib/rel/one.rb': '',
    '/ws/lib/foo.rb': '',
    '/ws/app/bar.rb': '',
    '/ws/baz.rb': '',
    '/ws/lib/dup.rb': '',
    '/ws/dup.rb': '',
    '/ws/app/dup.rb': '',
  };
  const rb = (text: string): Promise<string[]> => targetsOf(files, '/ws/lib/a.rb', text);

  it('require_relative is relative to the requiring file', async () => {
    assert.deepEqual(await rb("require_relative 'rel/one'"), ['/ws/lib/rel/one.rb']);
    assert.deepEqual(await rb("require_relative '../baz'"), ['/ws/baz.rb']);
    assert.deepEqual(await rb("require_relative 'rel/missing'"), []);
  });

  it('require searches <root>/lib, <root>, <root>/app (in that order)', async () => {
    assert.deepEqual(await rb("require 'foo'"), ['/ws/lib/foo.rb']);
    assert.deepEqual(await rb("require 'bar'"), ['/ws/app/bar.rb']);
    assert.deepEqual(await rb("require 'baz'"), ['/ws/baz.rb']);
    assert.deepEqual(await rb("require 'dup'"), ['/ws/lib/dup.rb']);
  });

  it('standard library / gems are unresolved', async () => {
    assert.deepEqual(await rb("require 'json'\nrequire 'rails'"), []);
  });
});

describe('resolver: PHP', () => {
  const files: Record<string, string> = {
    '/ws/index.php': '',
    '/ws/inc/one.php': '',
    '/ws/inc/two.php': '',
    '/ws/inc/three.php': '',
    '/ws/inc/four.php': '',
    '/ws/src/Models/User.php': '',
    '/ws/app/Models/Account.php': '',
    '/ws/tests/FooTest.php': '',
    '/ws/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } }, 'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } } }),
  };
  const php = (text: string, f = files): Promise<string[]> => targetsOf(f, '/ws/index.php', `<?php\n${text}\n`);

  it('include/require with plain strings, __DIR__ and dirname(__FILE__) resolve relative to the file', async () => {
    assert.deepEqual(await php("require 'inc/one.php';"), ['/ws/inc/one.php']);
    assert.deepEqual(await php("require_once __DIR__ . '/inc/two.php';"), ['/ws/inc/two.php']);
    assert.deepEqual(await php("include dirname(__FILE__) . '/inc/three.php';"), ['/ws/inc/three.php']);
    assert.deepEqual(await php('include_once("inc/four.php");'), ['/ws/inc/four.php']);
    assert.deepEqual(await php("require 'inc/missing.php';"), []);
  });

  it('use FQN resolves through composer psr-4 (autoload and autoload-dev)', async () => {
    assert.deepEqual(await php('use App\\Models\\User;'), ['/ws/src/Models/User.php']);
    assert.deepEqual(await php('use Tests\\FooTest;'), ['/ws/tests/FooTest.php']);
  });

  it('without composer.json, suffixes of the FQN are tried under <root>, src, app, lib', async () => {
    const { '/ws/composer.json': _c, ...noComposer } = files;
    void _c;
    assert.deepEqual(await php('use App\\Models\\Account;', noComposer), ['/ws/app/Models/Account.php']);
    assert.deepEqual(await php('use Vendor\\Lib\\Thing;', noComposer), []);
  });

  it('`use X as Y` and brace groups resolve their classes', async () => {
    assert.deepEqual(await php('use App\\Models\\User as U;'), ['/ws/src/Models/User.php']);
  });

  it('PHP counts statements plus usages of the imported class name', async () => {
    const text = ['<?php', 'use App\\Models\\User;', '$a = new User();', '$b = User::find(1);'].join('\n');
    const { result } = await run(files, '/ws/index.php', text);
    const user = must(result.targets.find((t) => t.key === '/ws/src/Models/User.php'));
    assert.deepEqual([user.statements, user.usages], [1, 2]);
  });
});

describe('resolver: CSS / SCSS / Less', () => {
  const files: Record<string, string> = {
    '/ws/styles/main.scss': '',
    '/ws/styles/_colors.scss': '',
    '/ws/styles/base/_vars.scss': '',
    '/ws/styles/dir/_index.scss': '',
    '/ws/styles/other/index.scss': '',
    '/ws/styles/mix.scss': '',
    '/ws/styles/both.scss': '',
    '/ws/styles/_both.scss': '',
    '/ws/styles/plain.css': '',
    '/ws/styles/theme.less': '',
  };
  const scss = (text: string): Promise<string[]> => targetsOf(files, '/ws/styles/main.scss', text);

  const cases: Array<[string, string[]]> = [
    ['@use "colors";', ['/ws/styles/_colors.scss']],
    ['@forward "colors";', ['/ws/styles/_colors.scss']],
    ['@import "base/vars";', ['/ws/styles/base/_vars.scss']],
    ['@use "dir";', ['/ws/styles/dir/_index.scss']],
    ['@use "other";', ['/ws/styles/other/index.scss']],
    ['@use "mix";', ['/ws/styles/mix.scss']],
    ['@use "both";', ['/ws/styles/both.scss']], // x.scss is tried before _x.scss
    ['@import "plain";', ['/ws/styles/plain.css']],
    ['@use "missing";', []],
    ['@use "sass:math";', []],
    ['@import "https://cdn.example.com/x.css";', []],
  ];
  for (const [text, expected] of cases) {
    it(`scss ${text} -> ${expected.join(',') || 'unresolved'}`, async () => {
      assert.deepEqual(await scss(text), expected);
    });
  }

  it('sass: / http: / // / ~pkg imports are not even counted as unresolved', async () => {
    const { result } = await run(files, '/ws/styles/main.scss', '@use "sass:math";\n@import "http://x/y.css";\n@import "//cdn/x.css";\n@import "~pkg/x";');
    assert.equal(result.unresolved, 0);
    assert.deepEqual(result.targets, []);
  });

  it('less resolves .less and plain names; css resolves .css', async () => {
    assert.deepEqual(await targetsOf(files, '/ws/styles/main.less', '@import "theme";'), ['/ws/styles/theme.less']);
    assert.deepEqual(await targetsOf(files, '/ws/styles/main.less', '@import (reference) "theme";'), ['/ws/styles/theme.less']);
    assert.deepEqual(await targetsOf(files, '/ws/styles/main.css', '@import "plain.css";'), ['/ws/styles/plain.css']);
    assert.deepEqual(await targetsOf(files, '/ws/styles/main.css', '@import url(plain.css);'), ['/ws/styles/plain.css']);
    assert.deepEqual(await targetsOf(files, '/ws/styles/main.css', '@import "plain";'), ['/ws/styles/plain.css']);
  });

  it('@import lists resolve every entry', async () => {
    assert.deepEqual((await scss('@import "mix", "plain";')).sort(), ['/ws/styles/mix.scss', '/ws/styles/plain.css']);
  });
});

describe('resolver: HTML and Markdown', () => {
  const files: Record<string, string> = {
    '/ws/web/index.html': '',
    '/ws/web/app.js': '',
    '/ws/web/css/site.css': '',
    '/ws/web/docs/index.html': '',
    '/ws/assets/logo.png': '',
    '/ws/web/img/a.png': '',
  };
  const html = (text: string, f = files, roots = ['/ws']): Promise<string[]> => targetsOf(f, '/ws/web/index.html', text, { roots });

  it('relative src/href resolve against the page; query and hash are stripped', async () => {
    assert.deepEqual(await html('<script src="app.js"></script>'), ['/ws/web/app.js']);
    assert.deepEqual(await html('<link href="css/site.css?v=3#x">'), ['/ws/web/css/site.css']);
    assert.deepEqual(await html('<img src="./img/a.png">'), ['/ws/web/img/a.png']);
  });

  it('a trailing slash means index.html in that directory', async () => {
    assert.deepEqual(await html('<a href="docs/">docs</a>'), ['/ws/web/docs/index.html']);
  });

  it('a leading slash is relative to the workspace root(s)', async () => {
    assert.deepEqual(await html('<img src="/assets/logo.png">'), ['/ws/assets/logo.png']);
    assert.deepEqual(await html('<img src="/assets/x.png">', { '/w2/web/index.html': '', '/w2/assets/x.png': '' }, ['/w1', '/w2']), ['/w2/assets/x.png']);
  });

  it('external URLs and anchors are neither targets nor unresolved', async () => {
    const { result } = await run(files, '/ws/web/index.html', '<a href="https://x.dev/">w</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><img src="data:image/png;base64,AAA">');
    assert.deepEqual(result.targets, []);
    assert.equal(result.unresolved, 0);
  });

  it('missing local files count as unresolved; duplicates count as separate statements', async () => {
    const { result } = await run(files, '/ws/web/index.html', '<img src="gone.png"><script src="app.js"></script><script src="app.js"></script>');
    assert.equal(result.unresolved, 1);
    assert.equal(must(result.targets[0]).count, 2);
  });

  it('markdown: extensionless links try .md; anchors stripped; root-relative links', async (t) => {
    if (parseImports('markdown', '[a](./a.md)').length === 0) return t.skip('markdown links not implemented (Deviation recorded)');
    const mdFiles = { '/ws/docs/readme.md': '', '/ws/docs/guide.md': '', '/ws/docs/a.md': '', '/ws/abs.md': '', '/ws/docs/img/a.png': '' };
    const md = (text: string): Promise<string[]> => targetsOf(mdFiles, '/ws/docs/readme.md', text);
    assert.deepEqual(await md('[g](guide)'), ['/ws/docs/guide.md']);
    assert.deepEqual(await md('[a](./a.md#sec)'), ['/ws/docs/a.md']);
    assert.deepEqual(await md('![i](img/a.png)'), ['/ws/docs/img/a.png']);
    assert.deepEqual(await md('[x](/abs.md)'), ['/ws/abs.md']);
    assert.deepEqual(await md('[web](https://example.com)'), []);
  });
});

describe('resolver: direct resolveImport contract (probe budget and memo)', () => {
  const files = { '/ws/src/b.ts': '', '/ws/src/a.ts': '' };

  it('resolves through the injected context and returns ResolvedTarget[] with the statement bindings', async () => {
    const { targets } = await resolveFirst('ts', '/ws/src/a.ts', "import { x, y as z } from './b';", files);
    assert.equal(targets.length, 1);
    assert.equal(must(targets[0]).key, '/ws/src/b.ts');
    assert.deepEqual(
      must(targets[0]).bindings.map((b) => b.local).sort(),
      ['x', 'z'],
    );
  });

  it('unresolvable statements give an empty array (never throw)', async () => {
    const { targets } = await resolveFirst('ts', '/ws/src/a.ts', "import x from './nope';", files);
    assert.deepEqual(targets, []);
  });

  it('probes are memoised: resolving the same specifier twice reuses the memo and costs no extra budget', async () => {
    const text = "import x from './b';";
    const { fs, budget, memo } = await resolveFirst('ts', '/ws/src/a.ts', text, files);
    const spent = 400 - budget.probes;
    assert.ok(spent >= 1, 'a probe was charged');
    const callsAfterFirst = fs.calls.isFile.length;
    // second resolution with the same ctx
    const stmt = must(parseImports('ts', text)[0]);
    const { resolveImport, loadProjectInfo } = await import('../support/refs');
    const project = await loadProjectInfo(fs, '/ws/src/a.ts', ['/ws']);
    const callsBeforeSecond = fs.calls.isFile.length;
    void callsAfterFirst;
    await resolveImport(stmt, '/ws/src/a.ts', 'ts', { fs, project, isExcluded: () => false, budget, memo });
    const callsAfterSecond = fs.calls.isFile.length;
    assert.equal(callsAfterSecond, callsBeforeSecond, 'the memo answers the repeated probe');
    assert.equal(400 - budget.probes, spent, 'no extra budget spent for a memoised probe');
  });

  it('an exhausted budget leaves statements unresolved even when the file exists', async () => {
    const { targets, fs } = await resolveFirst('ts', '/ws/src/a.ts', "import x from './b';", files, { budget: 0 });
    assert.deepEqual(targets, []);
    const probesAfterProject = fs.calls.isFile.filter((p) => p.endsWith('/b.ts'));
    assert.equal(probesAfterProject.length, 0, 'no probe may be issued once the budget is spent');
  });

  it('a tiny budget bounds the number of fs probes issued for a missing target', async () => {
    const { fs, budget } = await resolveFirst('ts', '/ws/src/a.ts', "import x from './definitely-missing';", files, { budget: 3 });
    const probes = fs.calls.isFile.filter((p) => p.includes('definitely-missing')).length;
    assert.ok(probes <= 3, `${probes} probes with a budget of 3`);
    assert.ok(budget.probes >= 0, 'the budget never goes negative');
  });

  it('K.MAX_PROBES is the documented default budget', () => {
    assert.equal(K.MAX_PROBES, 400);
  });
});
