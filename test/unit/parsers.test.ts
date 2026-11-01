import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, parseImports } from '../support/refs';
import type { ImportBinding, ImportKind, ImportStatement, LanguageKey } from '../support/types';
import { lineOf, must, readFixture, readRepoFile } from '../support/fixtures';
import { K } from '../../src/core/constants';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function parseSorted(lang: LanguageKey, text: string): ImportStatement[] {
  return [...parseImports(lang, text)].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function pairs(bindings: readonly ImportBinding[]): Array<[string, string]> {
  return bindings.map((b): [string, string] => [b.local, b.imported]).sort((a, b) => a[0].localeCompare(b[0]));
}

function locals(bindings: readonly ImportBinding[]): string[] {
  return bindings.map((b) => b.local).sort();
}

function findOne(stmts: readonly ImportStatement[], specifier: string): ImportStatement {
  const hits = stmts.filter((s) => s.specifier === specifier);
  assert.equal(hits.length, 1, `expected exactly one statement for ${JSON.stringify(specifier)}, got ${hits.length} (all: ${stmts.map((s) => s.specifier).join(' | ')})`);
  return must(hits[0]);
}

function assertNoNegatives(stmts: readonly ImportStatement[], marker = /neg/i): void {
  const bad = stmts.filter((s) => marker.test(s.specifier));
  assert.deepEqual(
    bad.map((s) => s.specifier),
    [],
    'imports inside comments / strings / templates must never be reported',
  );
}

const markdownDeviation = ((): boolean => {
  try {
    const design = readRepoFile('docs', 'DESIGN.md');
    const dev = design.slice(design.lastIndexOf('\n## Deviations'));
    return /markdown/i.test(dev);
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------------------------

describe('detectLanguage', () => {
  const byId: Array<[string, LanguageKey]> = [
    ['typescript', 'ts'],
    ['typescriptreact', 'ts'],
    ['javascript', 'js'],
    ['javascriptreact', 'js'],
    ['python', 'python'],
    ['go', 'go'],
    ['java', 'java'],
    ['kotlin', 'kotlin'],
    ['c', 'c'],
    ['cpp', 'cpp'],
    ['rust', 'rust'],
    ['ruby', 'ruby'],
    ['php', 'php'],
    ['css', 'css'],
    ['scss', 'scss'],
    ['less', 'less'],
    ['html', 'html'],
    ['markdown', 'markdown'],
  ];
  for (const [id, key] of byId) {
    it(`languageId ${id} -> ${key}`, () => assert.equal(detectLanguage(id, '/ws/file.unknownext'), key));
  }

  const byExt: Array<[string, LanguageKey]> = [
    ['a.ts', 'ts'],
    ['a.tsx', 'ts'],
    ['a.mts', 'ts'],
    ['a.cts', 'ts'],
    ['a.d.ts', 'ts'],
    ['a.js', 'js'],
    ['a.jsx', 'js'],
    ['a.mjs', 'js'],
    ['a.cjs', 'js'],
    ['a.py', 'python'],
    ['a.pyi', 'python'],
    ['a.go', 'go'],
    ['a.java', 'java'],
    ['a.kt', 'kotlin'],
    ['a.kts', 'kotlin'],
    ['a.c', 'c'],
    ['a.h', 'c'],
    ['a.cc', 'cpp'],
    ['a.cpp', 'cpp'],
    ['a.cxx', 'cpp'],
    ['a.hpp', 'cpp'],
    ['a.hh', 'cpp'],
    ['a.hxx', 'cpp'],
    ['a.rs', 'rust'],
    ['a.rb', 'ruby'],
    ['a.php', 'php'],
    ['a.css', 'css'],
    ['a.scss', 'scss'],
    ['a.less', 'less'],
    ['a.html', 'html'],
    ['a.htm', 'html'],
    ['a.md', 'markdown'],
    ['a.markdown', 'markdown'],
  ];
  for (const [file, key] of byExt) {
    it(`extension fallback ${file} -> ${key} when the languageId is unknown`, () => {
      assert.equal(detectLanguage('plaintext', `/ws/src/${file}`), key);
      assert.equal(detectLanguage('', `/ws/src/${file}`), key);
    });
  }

  it('the languageId wins over the extension', () => {
    assert.equal(detectLanguage('python', '/ws/x.ts'), 'python');
    assert.equal(detectLanguage('markdown', '/ws/x.js'), 'markdown');
  });

  it('unsupported languages are undefined', () => {
    assert.equal(detectLanguage('plaintext', '/ws/notes.txt'), undefined);
    assert.equal(detectLanguage('json', '/ws/package.json'), undefined);
    assert.equal(detectLanguage('shellscript', '/ws/run.sh'), undefined);
    assert.equal(detectLanguage('', '/ws/Makefile'), undefined);
    assert.equal(detectLanguage('', '/ws/.env'), undefined);
  });

  it('works with Windows paths', () => {
    assert.equal(detectLanguage('plaintext', 'c:/proj/src/a.tsx'), 'ts');
    assert.equal(detectLanguage('plaintext', 'C:\\proj\\src\\a.py'), 'python');
  });
});

// ---------------------------------------------------------------------------------------------
// TS / JS
// ---------------------------------------------------------------------------------------------

describe('parseImports: TypeScript fixture', () => {
  const text = readFixture('langs', 'ts.fixture');
  const stmts = parseSorted('ts', text);

  const positives: Array<{
    spec: string;
    kind: ImportKind | ImportKind[];
    anchor: string;
    typeOnly?: boolean;
    bindings?: Array<[string, string]>;
    localsOnly?: string[];
  }> = [
    { spec: './p-default', kind: 'import', anchor: "import Dflt from './p-default'", bindings: [['Dflt', 'default']] },
    {
      spec: './p-mixed',
      kind: 'import',
      anchor: "import Dflt2, {",
      bindings: [
        ['Dflt2', 'default'],
        ['a1', 'a1'],
        ['c1', 'b1'],
        ['T1', 'T1'],
      ],
    },
    { spec: './p-namespace', kind: 'import', anchor: "import * as ns from './p-namespace'", bindings: [['ns', '*']] },
    { spec: './p-side-effect', kind: 'import', anchor: "import './p-side-effect'", bindings: [] },
    { spec: './p-type-only', kind: 'import', anchor: 'import type { OnlyType }', typeOnly: true, bindings: [['OnlyType', 'OnlyType']] },
    { spec: './p-import-equals', kind: ['import', 'require'], anchor: "import legacy = require('./p-import-equals')" },
    { spec: './p-export-from', kind: 'export-from', anchor: "export { reA } from", bindings: [] },
    { spec: './p-export-star', kind: 'export-from', anchor: "export * from './p-export-star'", bindings: [] },
    { spec: './p-export-star-as', kind: 'export-from', anchor: 'export * as exNs', bindings: [] },
    { spec: './p-export-type', kind: 'export-from', anchor: 'export type { ReT }', typeOnly: true, bindings: [] },
    { spec: './p-require-const', kind: 'require', anchor: "const req1 = require('./p-require-const')", localsOnly: ['req1'] },
    {
      spec: './p-require-destructure',
      kind: 'require',
      anchor: 'let { r2a, r2b: r2c }',
      bindings: [
        ['r2a', 'r2a'],
        ['r2c', 'r2b'],
      ],
    },
    { spec: './p-require-var-double', kind: 'require', anchor: 'var r3 = require("./p-require-var-double")', localsOnly: ['r3'] },
    { spec: './p-require-inline', kind: 'require', anchor: "foo(require('./p-require-inline'))", bindings: [] },
    { spec: './p-dynamic', kind: 'dynamic', anchor: "const lazy = import('./p-dynamic')", bindings: [] },
    { spec: './p-in-template-expr', kind: 'require', anchor: 'const tpl = ' },
    {
      spec: './p-multiline',
      kind: 'import',
      anchor: 'import {\n  m1,',
      bindings: [
        ['m1', 'm1'],
        ['m3', 'm2'],
      ],
    },
    { spec: 'lodash', kind: 'import', anchor: "import bare from 'lodash'", bindings: [['bare', 'default']] },
    { spec: 'node:path', kind: 'import', anchor: "import nodePath from 'node:path'", bindings: [['nodePath', 'default']] },
    { spec: './p-after-regex', kind: 'dynamic', anchor: 'const re2 = /' },
    { spec: './p-after-division', kind: 'require', anchor: 'const div = total / 2' },
  ];

  it('reports exactly the positive statements: nothing extra, nothing duplicated', () => {
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      positives.map((p) => p.spec).sort(),
    );
  });

  it('never reports imports from comments, strings, template text, non-literal dynamic imports or lookalikes', () => {
    assertNoNegatives(stmts);
    assert.ok(!stmts.some((s) => /variableName|suffix/.test(s.specifier)));
  });

  for (const p of positives) {
    it(`${p.spec}: kind/line/bindings`, () => {
      const s = findOne(stmts, p.spec);
      const kinds = Array.isArray(p.kind) ? p.kind : [p.kind];
      assert.ok(kinds.includes(s.kind), `kind ${s.kind} not in ${kinds.join('|')}`);
      assert.equal(s.line, lineOf(text, p.anchor), 'line');
      assert.ok(s.endLine >= s.line, 'endLine >= line');
      if (p.typeOnly !== undefined) assert.equal(s.typeOnly, p.typeOnly, 'typeOnly');
      else assert.equal(s.typeOnly, false, 'typeOnly defaults to false');
      if (p.bindings) assert.deepEqual(pairs(s.bindings), pairs(p.bindings.map(([local, imported]) => ({ local, imported }))));
      if (p.localsOnly) assert.deepEqual(locals(s.bindings), p.localsOnly);
      assert.equal(s.relativeLevel, 0);
      assert.equal(s.angle, false);
      assert.equal(s.isStatic, false);
    });
  }

  it('multi-line braces: endLine is the line holding the specifier', () => {
    const s = findOne(stmts, './p-multiline');
    assert.equal(s.line, lineOf(text, 'import {\n  m1,'));
    assert.equal(s.endLine, lineOf(text, "} from './p-multiline'"));
    assert.equal(s.endLine - s.line, 3);
  });

  it('inline `type` modifier does not make the whole statement typeOnly', () => {
    assert.equal(findOne(stmts, './p-mixed').typeOnly, false);
  });

  it('statement order is stable and lines are 1-based', () => {
    assert.ok(stmts.every((s) => s.line >= 1));
  });
});

describe('parseImports: JavaScript fixture', () => {
  const text = readFixture('langs', 'js.fixture');
  const stmts = parseSorted('js', text);

  it('reports exactly the CommonJS / ESM positives', () => {
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      ['./p-cjs-a', './p-cjs-destructure', './p-cjs-reexport', './p-conditional-require', './p-esm', './p-js-dynamic', './p-js-export-from'].sort(),
    );
    assertNoNegatives(stmts);
  });

  it('kinds and bindings', () => {
    assert.equal(findOne(stmts, './p-cjs-a').kind, 'require');
    assert.deepEqual(locals(findOne(stmts, './p-cjs-a').bindings), ['a']);
    assert.deepEqual(
      pairs(findOne(stmts, './p-cjs-destructure').bindings),
      [
        ['b', 'b'],
        ['d', 'c'],
      ],
    );
    assert.deepEqual(findOne(stmts, './p-cjs-reexport').bindings, [], 'module.exports = require(...) binds nothing');
    assert.equal(findOne(stmts, './p-js-dynamic').kind, 'dynamic');
    assert.equal(findOne(stmts, './p-js-export-from').kind, 'export-from');
    assert.equal(findOne(stmts, './p-esm').kind, 'import');
  });
});

describe('parseImports: JS/TS corner cases', () => {
  it('TS and JS share the grammar (ts text parsed as js gives the same specifiers)', () => {
    const text = "import a from './a';\nconst b = require('./b');\nexport * from './c';\nimport('./d');\n";
    const ts = parseSorted('ts', text).map((s) => s.specifier);
    const js = parseSorted('js', text).map((s) => s.specifier);
    assert.deepEqual(ts, ['./a', './b', './c', './d']);
    assert.deepEqual(js, ts);
  });

  it('single-line files with many statements on one line', () => {
    const text = "import a from './a'; import b from './b'; const c = require('./c'); export * from './d';";
    const stmts = parseSorted('ts', text);
    assert.deepEqual(stmts.map((s) => s.specifier).sort(), ['./a', './b', './c', './d']);
    assert.ok(stmts.every((s) => s.line === 1 && s.endLine === 1));
  });

  it('CRLF line endings do not shift line numbers', () => {
    const text = "import a from './a';\r\nimport b from './b';\r\n\r\nimport c from './c';\r\n";
    const stmts = parseSorted('ts', text);
    assert.deepEqual(
      stmts.map((s) => [s.specifier, s.line]),
      [
        ['./a', 1],
        ['./b', 2],
        ['./c', 4],
      ],
    );
  });

  it('no trailing newline at EOF and no semicolons', () => {
    const stmts = parseSorted('ts', "import a from './a'\nimport b from './b'");
    assert.deepEqual(stmts.map((s) => s.specifier), ['./a', './b']);
  });

  it('double-quoted, single-quoted and backtick-free literal specifiers', () => {
    const stmts = parseSorted('ts', 'import a from "./dq";\nimport b from \'./sq\';\n');
    assert.deepEqual(stmts.map((s) => s.specifier), ['./dq', './sq']);
  });

  it('`import` used as an identifier or property is not a statement', () => {
    const text = [
      'const importance = 3;',
      'const obj = { import: 1 };',
      'obj.import = 2;',
      'const exported = 1;',
      'function requireAuth() {}',
      'requireAuth("./neg-prefix");',
      'const my_require = 1;',
      '',
    ].join('\n');
    assert.deepEqual(parseImports('ts', text), []);
  });

  it('an unterminated block comment swallows the rest, never throws', () => {
    const stmts = parseSorted('ts', "import a from './a';\n/* never closed\nimport b from './b';\n");
    assert.deepEqual(stmts.map((s) => s.specifier), ['./a']);
  });

  it('an unterminated template literal swallows the rest, never throws', () => {
    const stmts = parseSorted('ts', "import a from './a';\nconst t = `never closed\nimport b from './b';\n");
    assert.deepEqual(stmts.map((s) => s.specifier), ['./a']);
  });

  it('nested template literals keep ${ } bodies as code', () => {
    const text = "const t = `outer ${ `inner ${ require('./p-deep') } text` } tail require('./neg-tail')`;";
    const specs = parseImports('ts', text).map((s) => s.specifier);
    assert.ok(specs.includes('./p-deep'), specs.join(','));
    assert.ok(!specs.includes('./neg-tail'));
  });

  it('escaped quotes do not end a string early', () => {
    const text = "const s = 'it\\'s require(\"./neg-escaped\")';\nimport a from './p-after';\n";
    const specs = parseImports('ts', text).map((s) => s.specifier);
    assert.deepEqual(specs, ['./p-after']);
  });

  it('type-only forms are statements (they count) but flagged typeOnly', () => {
    const stmts = parseSorted('ts', "import type A from './a';\nimport type * as B from './b';\nexport type * from './c';\nimport { type D } from './d';\n");
    assert.equal(findOne(stmts, './a').typeOnly, true);
    assert.equal(findOne(stmts, './b').typeOnly, true);
    assert.equal(findOne(stmts, './d').typeOnly, false);
  });

  it('import attributes / assertions do not break the statement', () => {
    const stmts = parseSorted('ts', "import data from './data.json' with { type: 'json' };\nimport a from './a';\n");
    assert.deepEqual(stmts.map((s) => s.specifier).sort(), ['./a', './data.json']);
  });

  it('require with a template literal that has no substitution or a variable is ignored when not a plain string', () => {
    const specs = parseImports('ts', 'const a = require(name);\nconst b = require(`./x-${y}`);\n').map((s) => s.specifier);
    assert.deepEqual(specs, []);
  });

  it('empty input and whitespace-only input', () => {
    assert.deepEqual(parseImports('ts', ''), []);
    assert.deepEqual(parseImports('ts', '   \n\n\t'), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------

describe('parseImports: Python fixture', () => {
  const text = readFixture('langs', 'python.fixture');
  const stmts = parseImports('python', text);
  const norm = (s: ImportStatement): string => `${s.relativeLevel}:${s.specifier.replace(/^\.+/, '')}`;

  const expected: Array<{ key: string; bindings: Array<[string, string]> | null; localsOnly?: string[] }> = [
    { key: '0:os', bindings: null, localsOnly: ['os'] },
    { key: '0:pkg.mod', bindings: null, localsOnly: ['pkg.mod'] },
    { key: '0:pkg.other', bindings: null, localsOnly: ['po'] },
    { key: '0:a1', bindings: null, localsOnly: ['a1'] },
    { key: '0:b1', bindings: null, localsOnly: ['b1'] },
    {
      key: '0:pkg.sub',
      bindings: [
        ['c1', 'c1'],
        ['e1', 'd1'],
      ],
    },
    { key: '1:', bindings: [['rel_one', 'rel_one']] },
    { key: '2:', bindings: [['rel_two', 'rel_two']] },
    { key: '2:pkg', bindings: [['y', 'y']] },
    { key: '1:sibling', bindings: [['z', 'z']] },
    { key: '0:m', bindings: [] },
    {
      key: '0:long.mod',
      bindings: [
        ['q1', 'q1'],
        ['q3', 'q2'],
      ],
    },
    {
      key: '0:cont.mod',
      bindings: [
        ['r1', 'r1'],
        ['r2', 'r2'],
      ],
    },
    { key: '0:x.y.z', bindings: null, localsOnly: ['x.y.z'] },
    { key: '0:indented_mod', bindings: null, localsOnly: ['indented_mod'] },
    { key: '0:tmod', bindings: null, localsOnly: ['tmod'] },
  ];

  it('reports exactly the positive statements, once each', () => {
    assert.deepEqual(
      stmts.map(norm).sort(),
      expected.map((e) => e.key).sort(),
    );
  });

  it('never reports comments, docstrings, plain / f / raw-bytes / triple-quoted strings', () => {
    assertNoNegatives(stmts, /neg/i);
  });

  for (const e of expected) {
    it(`statement ${e.key}`, () => {
      const s = must(stmts.find((x) => norm(x) === e.key));
      assert.equal(s.kind, 'import');
      assert.equal(s.typeOnly, false);
      if (e.bindings) assert.deepEqual(pairs(s.bindings), pairs(e.bindings.map(([local, imported]) => ({ local, imported }))));
      if (e.localsOnly) assert.deepEqual(locals(s.bindings), e.localsOnly);
    });
  }

  it('relativeLevel counts leading dots', () => {
    assert.equal(must(stmts.find((s) => norm(s) === '1:sibling')).relativeLevel, 1);
    assert.equal(must(stmts.find((s) => norm(s) === '2:pkg')).relativeLevel, 2);
    assert.equal(must(stmts.find((s) => norm(s) === '0:os')).relativeLevel, 0);
  });

  it('`import a, b` yields two statements on the same line', () => {
    const line = lineOf(text, 'import a1, b1');
    const hits = stmts.filter((s) => s.specifier === 'a1' || s.specifier === 'b1');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((s) => s.line === line));
  });

  it('parenthesised and backslash-continued lists span lines', () => {
    const paren = must(stmts.find((s) => s.specifier === 'long.mod'));
    assert.equal(paren.line, lineOf(text, 'from long.mod import ('));
    assert.equal(paren.endLine, paren.line + 3);
    const cont = must(stmts.find((s) => s.specifier === 'cont.mod'));
    assert.equal(cont.line, lineOf(text, 'from cont.mod import'));
    assert.equal(cont.endLine, cont.line + 1);
  });

  it('indented imports (inside def / try) are found with the right line', () => {
    const s = must(stmts.find((x) => x.specifier === 'indented_mod'));
    assert.equal(s.line, lineOf(text, 'import indented_mod\n'));
  });

  it('backslash continuation with CRLF line endings', () => {
    const crlf = parseImports('python', 'from a.b import c, \\\r\n    d\r\nimport z\r\n');
    const ab = must(crlf.find((s) => s.specifier === 'a.b'));
    assert.deepEqual(locals(ab.bindings), ['c', 'd']);
    assert.equal(must(crlf.find((s) => s.specifier === 'z')).line, 3);
  });

  it('`import` / `from` as parts of other words or attributes are not statements', () => {
    const text2 = ['important = 1', 'x.import_module("neg")', 'from_here = 2', 'print("hi")', 'my_import os', ''].join('\n');
    assert.deepEqual(parseImports('python', text2), []);
  });

  it('a trailing comment after the import does not leak into the statement', () => {
    const s = must(parseImports('python', 'from a import b  # import neg_trailing\n')[0]);
    assert.equal(s.specifier, 'a');
    assert.deepEqual(locals(s.bindings), ['b']);
  });
});

// ---------------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------------

describe('parseImports: Go fixture', () => {
  const text = readFixture('langs', 'go.fixture');
  const stmts = parseSorted('go', text);
  const expected: Array<[string, string[]]> = [
    ['single/path', ['path']],
    ['aliased/path', ['alias']],
    ['blank/path', []],
    ['dot/path', []],
    ['grouped/one', ['one']],
    ['grouped/two', ['g2']],
    ['grouped/blank', []],
    ['example.com/mod/pkg/v2', ['pkg']],
  ];

  it('reports exactly the single, aliased, blank, dot and grouped imports', () => {
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      expected.map(([s]) => s).sort(),
    );
    assertNoNegatives(stmts);
  });

  for (const [spec, expectedLocals] of expected) {
    it(`${spec}: local binding ${JSON.stringify(expectedLocals)}`, () => {
      const s = findOne(stmts, spec);
      assert.equal(s.kind, 'import');
      assert.deepEqual(locals(s.bindings), expectedLocals);
      const memberLine = lineOf(text, `"${spec}"`);
      assert.ok(s.line <= memberLine && memberLine <= s.endLine, `line range ${s.line}-${s.endLine} must cover ${memberLine}`);
    });
  }

  it('the local name of a versioned module path skips the trailing vN segment', () => {
    assert.deepEqual(locals(findOne(stmts, 'example.com/mod/pkg/v2').bindings), ['pkg']);
    const gp = parseImports('go', 'import "github.com/x/y/v10"\nimport "gopkg.in/yaml.v3"\n');
    assert.deepEqual(locals(must(gp.find((s) => s.specifier === 'github.com/x/y/v10')).bindings), ['y']);
  });

  it('`.` and `_` imports produce no binding', () => {
    assert.deepEqual(findOne(stmts, 'dot/path').bindings, []);
    assert.deepEqual(findOne(stmts, 'blank/path').bindings, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Java / Kotlin
// ---------------------------------------------------------------------------------------------

describe('parseImports: Java fixture', () => {
  const stmts = parseSorted('java', readFixture('langs', 'java.fixture'));
  const bySpec = (spec: string): ImportStatement => must(stmts.find((s) => s.specifier.replace(/\.\*$/, '') === spec.replace(/\.\*$/, '') && (spec.endsWith('.*') === s.specifier.endsWith('.*') || !s.specifier.endsWith('.*'))));

  it('reports the five imports and nothing from comments, strings or text blocks', () => {
    assert.equal(stmts.length, 5);
    assertNoNegatives(stmts, /neg|InString|TextBlock/);
  });

  it('plain import: simple-name binding, not static', () => {
    const s = findOne(stmts, 'com.example.util.Helper');
    assert.deepEqual(locals(s.bindings), ['Helper']);
    assert.equal(s.isStatic, false);
    assert.equal(s.kind, 'import');
  });

  it('static import: member-name binding and isStatic', () => {
    const s = findOne(stmts, 'com.example.util.Constants.MAX');
    assert.deepEqual(locals(s.bindings), ['MAX']);
    assert.equal(s.isStatic, true);
  });

  it('wildcards are parsed, bind nothing, and keep the package', () => {
    const w = stmts.filter((s) => s.specifier.startsWith('com.example.model'));
    assert.equal(w.length, 1);
    assert.deepEqual(must(w[0]).bindings, []);
    const sw = stmts.filter((s) => s.specifier.startsWith('com.example.util.Statics'));
    assert.equal(sw.length, 1);
    assert.deepEqual(must(sw[0]).bindings, []);
    assert.equal(must(sw[0]).isStatic, true);
    assert.ok(bySpec('com.example.model.*'));
  });

  it('java.* imports are statements too (resolution decides they are external)', () => {
    assert.deepEqual(locals(findOne(stmts, 'java.util.List').bindings), ['List']);
  });
});

describe('parseImports: Kotlin fixture', () => {
  const stmts = parseSorted('kotlin', readFixture('langs', 'kotlin.fixture'));

  it('reports four imports (no semicolons) and nothing from comments / strings / raw strings', () => {
    assert.equal(stmts.length, 4);
    assertNoNegatives(stmts, /neg|InString|TextBlock/);
  });

  it('plain and aliased imports of the same class', () => {
    const helpers = stmts.filter((s) => s.specifier === 'com.example.util.Helper');
    assert.equal(helpers.length, 2);
    assert.deepEqual(
      helpers.map((s) => locals(s.bindings)).sort(),
      [['H'], ['Helper']],
    );
  });

  it('member import and wildcard', () => {
    assert.deepEqual(locals(findOne(stmts, 'com.example.util.Constants.MAX').bindings), ['MAX']);
    const w = stmts.filter((s) => s.specifier.startsWith('com.example.model'));
    assert.equal(w.length, 1);
    assert.deepEqual(must(w[0]).bindings, []);
  });
});

// ---------------------------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------------------------

describe('parseImports: C fixture', () => {
  const text = readFixture('langs', 'c.fixture');
  for (const lang of ['c', 'cpp'] as const) {
    describe(lang, () => {
      const stmts = parseSorted(lang, text);

      it('reports every #include (including duplicates) and ignores #import, comments and strings', () => {
        assert.deepEqual(
          stmts.map((s) => s.specifier),
          ['local.h', 'system.h', 'spaced.h', 'commented.h', 'dup.h', 'dup.h', 'sub/dir/nested.h'],
        );
        assertNoNegatives(stmts);
      });

      it('angle flag distinguishes <...> from "..."', () => {
        assert.equal(findOne(stmts, 'system.h').angle, true);
        for (const s of stmts.filter((x) => x.specifier !== 'system.h')) assert.equal(s.angle, false, s.specifier);
      });

      it('kind include, no bindings, correct lines', () => {
        for (const s of stmts) {
          assert.equal(s.kind, 'include');
          assert.deepEqual(s.bindings, []);
          assert.equal(s.relativeLevel, 0);
        }
        assert.equal(findOne(stmts, 'local.h').line, 1);
        assert.equal(findOne(stmts, 'commented.h').line, lineOf(text, 'commented.h'));
        const dups = stmts.filter((s) => s.specifier === 'dup.h');
        assert.deepEqual(
          dups.map((s) => s.line),
          [5, 6],
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------------------------

describe('parseImports: Rust fixture', () => {
  const text = readFixture('langs', 'rust.fixture');
  const stmts = parseSorted('rust', text);

  it('`mod name;` is reported, `mod name { }` is not', () => {
    const mods = stmts.filter((s) => s.kind === 'mod').map((s) => s.specifier);
    assert.deepEqual(mods.sort(), ['after_char', 'after_lifetime', 'child', 'pubchild']);
    assert.ok(!stmts.some((s) => s.specifier.includes('inline_mod')));
  });

  it('use paths are reported (crate-local and external alike)', () => {
    const uses = stmts.filter((s) => s.kind === 'use').map((s) => s.specifier);
    assert.ok(uses.some((u) => u.startsWith('crate::a::b')), uses.join(' | '));
    assert.ok(uses.some((u) => u.startsWith('self::sib')));
    assert.ok(uses.some((u) => u.startsWith('super::up')));
    assert.ok(uses.some((u) => u.startsWith('crate::re::exported')));
    assert.ok(uses.some((u) => u.startsWith('std::collections')));
    assert.ok(uses.some((u) => u.startsWith('serde')));
  });

  it('brace lists and aliases produce the right local names', () => {
    const braces = stmts.filter((s) => s.kind === 'use' && s.specifier.startsWith('crate::a::b'));
    const allBindings = braces.flatMap((s) => s.bindings);
    assert.deepEqual(locals(allBindings), ['C', 'E']);
    assert.equal(must(allBindings.find((b) => b.local === 'E')).imported, 'D');
  });

  it('single-item use binds the last segment', () => {
    const sib = must(stmts.find((s) => s.kind === 'use' && s.specifier.startsWith('self::sib')));
    assert.deepEqual(locals(sib.bindings), ['F']);
    const pubUse = must(stmts.find((s) => s.kind === 'use' && s.specifier.startsWith('crate::re::exported')));
    assert.deepEqual(locals(pubUse.bindings), ['H']);
  });

  it('nothing from comments (including NESTED block comments), strings or raw strings; lifetimes and char literals do not swallow later code', () => {
    assertNoNegatives(stmts);
    assert.ok(!stmts.some((s) => s.specifier.includes('after_nested')), 'a nested block comment must stay a comment');
    assert.ok(stmts.some((s) => s.specifier === 'after_lifetime'), "lifetime 'a must not start a char literal");
    assert.ok(stmts.some((s) => s.specifier === 'after_char'), "char literal 'x' must end properly");
  });
});

// ---------------------------------------------------------------------------------------------
// Ruby / PHP
// ---------------------------------------------------------------------------------------------

describe('parseImports: Ruby fixture', () => {
  const stmts = parseSorted('ruby', readFixture('langs', 'ruby.fixture'));
  const norm = (s: string): string => s.replace(/^\.\//, '');

  it('require_relative, require, load and autoload are reported; comments, =begin blocks and strings are not', () => {
    assert.deepEqual(
      stmts.map((s) => norm(s.specifier)).sort(),
      ['gem_or_lib', 'rel/double', 'rel/one', 'script.rb', 'thing/file'],
    );
    assertNoNegatives(stmts);
  });

  it('Ruby statements carry no bindings', () => {
    for (const s of stmts) assert.deepEqual(s.bindings, []);
  });
});

describe('parseImports: PHP fixture', () => {
  const stmts = parseSorted('php', readFixture('langs', 'php.fixture'));

  it('include/require forms with plain strings, __DIR__ and dirname(__FILE__)', () => {
    const files = stmts.map((s) => s.specifier);
    for (const tail of ['inc/one.php', 'inc/two.php', 'inc/three.php', 'inc/four.php']) {
      assert.ok(
        files.some((f) => f.endsWith(tail)),
        `${tail} not found in ${files.join(' | ')}`,
      );
    }
  });

  it('`use` imports: class, alias and brace group; `use function` / `use const` are skipped', () => {
    const uses = stmts.filter((s) => s.specifier.startsWith('App\\'));
    assert.ok(uses.some((s) => s.specifier === 'App\\Models\\User' && locals(s.bindings).join() === 'User'));
    assert.ok(uses.some((s) => s.specifier === 'App\\Services\\Mailer' && locals(s.bindings).join() === 'M'));
    const group = uses.filter((s) => s.specifier.startsWith('App\\Util'));
    assert.deepEqual(locals(group.flatMap((s) => s.bindings)), ['Helper', 'Other']);
    assert.ok(!uses.some((s) => /neg/i.test(s.specifier)), 'use function / use const must not be reported');
  });

  it('only code inside <?php ... ?> counts; comments (//, #, /* */) and strings do not', () => {
    assertNoNegatives(stmts, /neg_/);
    assert.ok(stmts.some((s) => s.specifier.endsWith('after_close.php')), 'a second <?php block after ?> is code again');
  });
});

// ---------------------------------------------------------------------------------------------
// CSS family / HTML / Markdown
// ---------------------------------------------------------------------------------------------

describe('parseImports: CSS, SCSS and Less fixtures', () => {
  it('css', () => {
    const stmts = parseSorted('css', readFixture('langs', 'css.fixture'));
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      ['p-css-list-a.css', 'p-css-list-b.css', 'p-css-one.css', 'p-css-url-bare.css', 'p-css-url-quoted.css'],
    );
    for (const s of stmts) {
      assert.equal(s.kind, 'style-import');
      assert.deepEqual(s.bindings, []);
    }
    assertNoNegatives(stmts);
  });

  it('scss: @use, @use ... as, @use ... with, @forward, @import lists; skips sass:*, pkg:, ~pkg, URLs; // comments are comments', () => {
    const stmts = parseSorted('scss', readFixture('langs', 'scss.fixture'));
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      ['p-forward', 'p-scss-a', 'p-scss-b', 'p-scss-import', 'p-use', 'p-use-as', 'p-use-with'],
    );
    assertNoNegatives(stmts);
    assert.ok(!stmts.some((s) => /sass:|pkg:|~|https?:/.test(s.specifier)));
  });

  it('less: @import with options and url()', () => {
    const stmts = parseSorted('less', readFixture('langs', 'less.fixture'));
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      ['p-less-css', 'p-less-one', 'p-less-ref', 'p-less-url'],
    );
    assertNoNegatives(stmts);
  });

  it('in plain CSS `//` is not a comment marker, so only /* */ hides an @import', () => {
    const stmts = parseImports('css', '/* @import "neg-block.css"; */\n@import "p-real.css";\n');
    assert.deepEqual(stmts.map((s) => s.specifier), ['p-real.css']);
  });
});

describe('parseImports: HTML fixture', () => {
  const stmts = parseSorted('html', readFixture('langs', 'html.fixture'));

  it('src= / href= on any tag, quoted or unquoted, query and hash stripped, one statement per attribute', () => {
    assert.deepEqual(
      stmts.map((s) => s.specifier).sort(),
      ['p-dup.html', 'p-dup.html', 'p-link.html', 'p-multiline-tag.png', 'p-script.js', 'p-single-quote.png', 'p-style.css', 'p-unquoted.png'],
    );
  });

  it('skips scheme URLs, protocol-relative, #anchors, data:, mailto:, javascript: and commented-out tags', () => {
    assertNoNegatives(stmts);
    assert.ok(!stmts.some((s) => /^[a-z][a-z0-9+.-]*:/i.test(s.specifier) || s.specifier.startsWith('//') || s.specifier.startsWith('#')));
  });

  it('kind is link and there are no bindings', () => {
    for (const s of stmts) {
      assert.equal(s.kind, 'link');
      assert.deepEqual(s.bindings, []);
    }
  });

  it('a tag spread over several lines is found', () => {
    assert.ok(stmts.some((s) => s.specifier === 'p-multiline-tag.png'));
  });
});

describe('parseImports: Markdown fixture', () => {
  const stmts = parseSorted('markdown', readFixture('langs', 'markdown.fixture'));
  const supported = stmts.length > 0;

  it('markdown links are either supported or recorded in DESIGN.md Deviations', (t) => {
    if (!supported && !markdownDeviation) {
      assert.fail('markdown links are not parsed and DESIGN.md "## Deviations" does not mention markdown');
    }
    if (!supported) t.skip('markdown link parsing skipped by the Builder (recorded in Deviations)');
  });

  it('inline links, images, reference definitions; query/hash/angle brackets stripped', (t) => {
    if (!supported) return t.skip('markdown not implemented (Deviation recorded)');
    assert.deepEqual(
      stmts.map((s) => s.specifier.replace(/^\.\//, '')).sort(),
      ['p-angle.md', 'p-image.png', 'p-inline.md', 'p-query.md', 'p-ref-def.md'],
    );
    for (const s of stmts) assert.equal(s.kind, 'markdown-link');
  });

  it('skips URLs, anchors, mailto, inline code, fenced code (``` and ~~~) and HTML comments', (t) => {
    if (!supported) return t.skip('markdown not implemented (Deviation recorded)');
    assertNoNegatives(stmts);
  });
});

// ---------------------------------------------------------------------------------------------
// Cross-language invariants
// ---------------------------------------------------------------------------------------------

describe('parseImports: invariants for every language', () => {
  const langs: LanguageKey[] = ['ts', 'js', 'python', 'go', 'java', 'kotlin', 'c', 'cpp', 'rust', 'ruby', 'php', 'css', 'scss', 'less', 'html', 'markdown'];

  for (const lang of langs) {
    it(`${lang}: empty / whitespace input -> []`, () => {
      assert.deepEqual(parseImports(lang, ''), []);
      assert.deepEqual(parseImports(lang, ' \n\t\r\n'), []);
    });

    it(`${lang}: total on hostile input (pseudo-random token soup), bounded and well-formed`, () => {
      const alphabet = ["'", '"', '`', '/', '*', '#', '\n', '\\', '${', '}', '{', '(', ')', '<', '>', '?', '=', 'import ', 'from ', 'require(', '@import ', '#include ', 'use ', 'mod ', 'src=', 'href=', '<?php ', '?>', '"""', "'''", '=begin\n', '=end\n', ' ', '.', ',', ';', 'a', 'b/c'];
      let seed = 987654;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let round = 0; round < 60; round++) {
        let text = '';
        const n = 20 + Math.floor(rnd() * 200);
        for (let i = 0; i < n; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
        let out: ImportStatement[] = [];
        assert.doesNotThrow(() => {
          out = parseImports(lang, text);
        }, JSON.stringify(text));
        assert.ok(out.length <= K.MAX_STATEMENTS);
        for (const s of out) {
          assert.equal(typeof s.specifier, 'string');
          assert.ok(s.specifier.length <= 512);
          assert.ok(!s.specifier.includes('\u0000') && !s.specifier.includes('\n'));
          assert.ok(Number.isInteger(s.line) && s.line >= 1, `line ${s.line}`);
          assert.ok(s.endLine >= s.line);
          assert.ok(Array.isArray(s.bindings));
          assert.equal(typeof s.typeOnly, 'boolean');
          assert.ok(Number.isInteger(s.relativeLevel) && s.relativeLevel >= 0);
        }
      }
    });
  }

  it('stops after MAX_STATEMENTS statements', () => {
    const tsText = Array.from({ length: 2500 }, (_, i) => `import 'm${i}';`).join('\n');
    assert.equal(parseImports('ts', tsText).length, K.MAX_STATEMENTS);
    const pyText = Array.from({ length: 2500 }, (_, i) => `import m${i}`).join('\n');
    assert.equal(parseImports('python', pyText).length, K.MAX_STATEMENTS);
    const cText = Array.from({ length: 2500 }, (_, i) => `#include "h${i}.h"`).join('\n');
    assert.equal(parseImports('c', cText).length, K.MAX_STATEMENTS);
  });

  it('ignores specifiers longer than 512 characters, containing NUL or containing a newline; accepts exactly 512', () => {
    const ok = 'a'.repeat(512);
    const tooLong = 'b'.repeat(513);
    const text = `import '${ok}';\nimport '${tooLong}';\nimport 'x\u0000y';\nimport 'p\nq';\nimport './fine';\n`;
    const specs = parseImports('ts', text).map((s) => s.specifier);
    assert.ok(specs.includes(ok), '512 chars is allowed');
    assert.ok(!specs.includes(tooLong), '513 chars is rejected');
    assert.ok(!specs.some((s) => s.includes('\u0000') || s.includes('\n')));
    assert.ok(specs.includes('./fine'), 'later statements are still found');
  });
});
