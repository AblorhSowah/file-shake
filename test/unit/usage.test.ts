import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countUsages, scanCode } from '../support/refs';
import type { ImportBinding } from '../support/types';

const b = (local: string, imported = local): ImportBinding => ({ local, imported });
const none = new Set<number>();

describe('countUsages: identifier boundaries', () => {
  it('counts whole-identifier occurrences', () => {
    assert.equal(countUsages('a(); a(); x = a;', [b('a')], none), 3);
  });

  it('does not count when glued to identifier characters', () => {
    const text = 'ab a1 _a a$ $a aa xa ax a_ 9a a9';
    assert.equal(countUsages(text, [b('a')], none), 0);
  });

  it('counts at the very start and the very end of the text', () => {
    assert.equal(countUsages('a', [b('a')], none), 1);
    assert.equal(countUsages('a+a', [b('a')], none), 2);
  });

  it('does not count member accesses (single preceding dot) but does count spread and optional chaining as the spec says', () => {
    assert.equal(countUsages('x.a', [b('a')], none), 0, 'x.a is a property, not the import');
    assert.equal(countUsages('foo(...a)', [b('a')], none), 1, 'a spread of a counts');
    assert.equal(countUsages('x?.a', [b('a')], none), 1, 'DESIGN 8.2: `?.` before is allowed');
    assert.equal(countUsages('this.a = a', [b('a')], none), 1, 'only the bare `a` counts');
  });

  it('counts next to any punctuation or operator', () => {
    assert.equal(countUsages('(a)[a]{a}<a>a;a,a:a?a!a', [b('a')], none), 10);
  });

  it('empty text, empty bindings and empty locals count nothing and never loop', () => {
    assert.equal(countUsages('', [b('a')], none), 0);
    assert.equal(countUsages('a a a', [], none), 0);
    assert.equal(countUsages('a a a', [b('')], none), 0);
  });
});

describe('countUsages: distinct locals and special characters', () => {
  it('each distinct local counts separately; duplicate locals are counted once', () => {
    assert.equal(countUsages('a b a c', [b('a'), b('b')], none), 3);
    assert.equal(countUsages('a b a c', [b('a'), b('a', 'other')], none), 2, 'the same local twice must not double count');
  });

  it('locals are matched literally, not as regular expressions', () => {
    assert.equal(countUsages('x = $ + $;', [b('$')], none), 2);
    assert.equal(countUsages('(a) (a)', [b('(')], none), 0);
    assert.doesNotThrow(() => countUsages('anything', [b('['), b('.*'), b('a|b'), b('\\')], none));
    assert.equal(countUsages('ab abc a.b', [b('a.b')], none), 1, 'a dotted local is a literal sequence');
  });

  it('dotted locals (python a.b.c) match as a literal sequence with the same boundaries', () => {
    assert.equal(countUsages('pkg.mod.f() pkg.mod.g()', [b('pkg.mod')], none), 2);
    assert.equal(countUsages('xpkg.mod pkg.modx x.pkg.mod', [b('pkg.mod')], none), 0);
    assert.equal(countUsages('pkg.mod', [b('pkg.mod')], none), 1);
  });
});

describe('countUsages: excluded lines', () => {
  it('occurrences on excluded (import statement) lines are not counted; lines are 1-based', () => {
    const text = ['import { a } from "./x"', 'a(); a();', 'const k = 1', 'a'].join('\n');
    assert.equal(countUsages(text, [b('a')], new Set([1])), 3);
    assert.equal(countUsages(text, [b('a')], new Set([2])), 2);
    assert.equal(countUsages(text, [b('a')], new Set([1, 2, 4])), 0);
    assert.equal(countUsages(text, [b('a')], new Set([99])), 4, 'excluding a line that does not exist changes nothing');
  });

  it('works with CRLF text (line numbers follow \\n)', () => {
    const text = 'a\r\na\r\na';
    assert.equal(countUsages(text, [b('a')], new Set([2])), 2);
  });
});

describe('countUsages: used together with scanCode (comments and strings never count)', () => {
  it('DESIGN 14 example 1', () => {
    const text = [
      "import { a, b as bee } from './util';",
      "import * as p from 'node:path';",
      "import './side';",
      'const x = a() + a() + bee(); // a() ignored',
      'const s = "a()";',
    ].join('\n');
    const { masked } = scanCode('ts', text);
    assert.equal(countUsages(masked, [b('a'), b('bee', 'b')], new Set([1])), 3);
  });

  it('template text is not counted but ${ } bodies are', () => {
    const { masked } = scanCode('ts', 'const t = `a ${a} a`; a;');
    assert.equal(countUsages(masked, [b('a')], none), 2);
  });
});

describe('countUsages: behaviours the design documents as NOT modelled (asserted as current behaviour)', () => {
  it('shadowing / redeclaration still counts', () => {
    const { masked } = scanCode('ts', 'import { foo } from "./m";\nfunction g(foo) { return foo; }\nconst foo2 = 1;');
    assert.equal(countUsages(masked, [b('foo')], new Set([1])), 2);
  });

  it('object-literal keys count', () => {
    const { masked } = scanCode('ts', 'import { foo } from "./m";\nconst o = { foo: 1 };');
    assert.equal(countUsages(masked, [b('foo')], new Set([1])), 1);
  });

  it('JSX text counts', () => {
    const { masked } = scanCode('ts', 'import { Foo } from "./m";\nconst el = <div>Foo</div>;');
    assert.equal(countUsages(masked, [b('Foo')], new Set([1])), 1);
  });

  it('python f-string expressions are NOT counted (strings are blanked)', () => {
    const { masked } = scanCode('python', 'from .u import val\nprint(f"{val}")\nprint(val)\n');
    assert.equal(countUsages(masked, [b('val')], new Set([1])), 1);
  });
});
