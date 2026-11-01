import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanCode } from '../support/refs';
import type { LanguageKey } from '../support/types';

const lines = (...l: string[]): string => l.join('\n');

/** Structural invariants every scan must satisfy. */
function assertScanShape(lang: LanguageKey, text: string): void {
  const { masked, strings } = scanCode(lang, text);
  assert.equal(masked.length, text.length, 'masked has the same length as the input');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') assert.equal(masked[i], '\n', `newline preserved at ${i}`);
    if (text[i] === '\r') assert.equal(masked[i], '\r', `carriage return preserved at ${i}`);
  }
  for (const [offset, content] of strings) {
    assert.ok(offset >= 0 && offset < text.length);
    assert.equal(typeof content, 'string');
  }
}

describe('scanCode: shape invariants', () => {
  const langs: LanguageKey[] = ['ts', 'js', 'python', 'go', 'java', 'kotlin', 'c', 'cpp', 'rust', 'ruby', 'php', 'css', 'scss', 'less', 'html', 'markdown'];
  const samples = [
    '',
    'plain text',
    lines("import a from './a'; // c", '/* block', 'spans */ const s = "x";'),
    'const t = `a ${ `b ${ c } d` } e`;',
    'x = """doc\nstring"""\ny = r\'raw\'',
    "let c = 'x'; fn f<'a>() {} r#\"raw\"#",
    '<?php echo "x"; ?> html <?= $y ?>',
    '<!-- c --> <a href="x.html">t</a>',
    '```\ncode\n```\n[l](a.md) `inline`',
    "unterminated 'string\nand /* comment",
    '\r\nCRLF\r\n"str"\r\n',
    '   weird separators "x"',
    '/' + '*'.repeat(100),
    '"'.repeat(51),
  ];
  for (const lang of langs) {
    it(`${lang}: length, newlines and CRs are preserved on varied inputs`, () => {
      for (const s of samples) assertScanShape(lang, s);
    });
  }

  it('is total: pseudo-random token soup never throws for any language', () => {
    const alphabet = ["'", '"', '`', '/', '*', '#', '\n', '\\', '${', '}', '(', ')', '<', '>', '?', '=', '!--', '-->', '"""', "'''", '=begin\n', '=end\n', '<?php', '?>', 'r#"', '"#', '```', '~~~', 'a', ' '];
    let seed = 424242;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const langs2: LanguageKey[] = ['ts', 'python', 'rust', 'go', 'php', 'ruby', 'css', 'html', 'markdown', 'java', 'c'];
    for (const lang of langs2) {
      for (let round = 0; round < 40; round++) {
        let text = '';
        for (let i = 0, n = 10 + Math.floor(rnd() * 120); i < n; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
        assertScanShape(lang, text);
      }
    }
  });
});

describe('scanCode: C-like languages (ts shown)', () => {
  it('line comments are blanked to the end of the line only', () => {
    const { masked } = scanCode('ts', lines('a // gone', 'b'));
    assert.equal(masked, lines('a        ', 'b'));
  });

  it('block comments are blanked across lines, newlines kept', () => {
    const { masked } = scanCode('ts', lines('a /* x', 'y */ b'));
    assert.equal(masked, lines('a     ', '     b'));
  });

  it('string contents are blanked, quotes kept, and the raw content is exposed by opening-quote offset', () => {
    const text = "import a from 'm';";
    const { masked, strings } = scanCode('ts', text);
    const q = text.indexOf("'");
    assert.equal(masked, "import a from ' ';");
    assert.equal(strings.get(q), 'm');
  });

  it('double-quoted strings behave the same', () => {
    const text = 'x = "hello world";';
    const { masked, strings } = scanCode('ts', text);
    assert.equal(masked, 'x = "           ";');
    assert.equal(strings.get(text.indexOf('"')), 'hello world');
  });

  it('comment markers inside strings do not start comments, and quotes inside comments do not start strings', () => {
    const a = scanCode('ts', 'const u = "http://x.y/*z*/"; const v = 1;').masked;
    assert.ok(a.includes('const v = 1;'));
    const b = scanCode('ts', "// it's a comment\nconst w = 2;").masked;
    assert.ok(b.includes('const w = 2;'));
  });

  it('escaped quotes stay inside the string; an escaped backslash does not escape the closing quote', () => {
    const a = scanCode('ts', "const s = 'a\\'b'; const after = 1;").masked;
    assert.ok(a.includes('const after = 1;'));
    const b = scanCode('ts', 'const s = "a\\\\"; const after2 = 2;').masked;
    assert.ok(b.includes('const after2 = 2;'));
  });

  it('template literal text is blanked but ${ } bodies stay code, including nesting', () => {
    const text = 'const t = `text ${ foo(1) } more ${ `inner ${ bar } txt` } end`; after();';
    const { masked } = scanCode('ts', text);
    assert.ok(masked.includes('foo(1)'));
    assert.ok(masked.includes('bar'));
    assert.ok(!masked.includes('text'));
    assert.ok(!masked.includes('more'));
    assert.ok(!masked.includes('inner'));
    assert.ok(!masked.includes(' end'));
    assert.ok(masked.includes('after();'));
  });

  it('a string inside a ${ } body is blanked like any string', () => {
    const { masked } = scanCode('ts', "const t = `${ foo('secret') }`;");
    assert.ok(masked.includes('foo('));
    assert.ok(!masked.includes('secret'));
  });

  it('regex literals are recognised after ( , = : [ ! & | ? { } ; and at line start', () => {
    for (const prefix of ['x = ', 'f(', 'a, ', '{ k: ', '[', '!', 'a && ', 'a || ', 'c ? ', '{ ', '} ', 'a; ', '']) {
      const text = `${prefix}/'/; keep();`;
      const { masked } = scanCode('ts', text);
      assert.ok(masked.includes('keep();'), `prefix ${JSON.stringify(prefix)} -> ${masked}`);
    }
  });

  it('division is not a regex', () => {
    const { masked } = scanCode('ts', "const d = total / 2; const e = require('./x');");
    assert.ok(masked.includes('require('));
    const { strings } = scanCode('ts', "const d = total / 2; const e = require('./x');");
    assert.ok([...strings.values()].includes('./x'));
  });

  it('unterminated block comments and templates blank to EOF', () => {
    const a = scanCode('ts', 'x /* never closed\nimport y').masked;
    assert.ok(!a.includes('import'));
    const b = scanCode('ts', 'x `never closed ${\nimport y').masked;
    assert.equal(b.length, 'x `never closed ${\nimport y'.length);
  });

  it('does not treat // inside a regex literal as a comment start', () => {
    const { masked } = scanCode('ts', 'const re = /a\\/\\/b/; keep();');
    assert.ok(masked.includes('keep();'));
  });
});

describe('scanCode: Rust', () => {
  it('block comments nest', () => {
    const { masked } = scanCode('rust', '/* a /* b */ still comment */ code();');
    assert.ok(masked.includes('code();'));
    assert.ok(!masked.includes('still'));
  });

  it('raw strings r#"..."# may contain quotes; contents blanked', () => {
    const text = 'let r = r#"say "hi" use crate::x;"#; after();';
    const { masked } = scanCode('rust', text);
    assert.ok(!masked.includes('use crate'));
    assert.ok(masked.includes('after();'));
  });

  it("lifetimes ('a) are not char literals; char literals are", () => {
    const { masked } = scanCode('rust', "fn f<'a>(x: &'a str) -> &'a str { x } mod after;");
    assert.ok(masked.includes('mod after;'));
    assert.ok(masked.includes('str'));
    const c = scanCode('rust', "let c = 'x'; let d = '\\n'; mod after2;").masked;
    assert.ok(c.includes('mod after2;'));
  });
});

describe('scanCode: Go, Java, Kotlin', () => {
  it('Go raw strings span lines and are blanked', () => {
    const text = lines('x := `import "neg"', 'still raw` ; ok()');
    const { masked } = scanCode('go', text);
    assert.ok(!masked.includes('neg'));
    assert.ok(!masked.includes('still'));
    assert.ok(masked.includes('ok()'));
    assert.equal(masked.split('\n').length, 2);
  });

  it('Java text blocks are blanked across lines', () => {
    const text = lines('String s = """', '    import a.B;', '    """;', 'int after = 1;');
    const { masked } = scanCode('java', text);
    assert.ok(!masked.includes('import'));
    assert.ok(masked.includes('int after = 1;'));
  });

  it('Kotlin raw strings are blanked across lines', () => {
    const text = lines('val s = """', '    import a.B', '    """', 'val after = 1');
    const { masked } = scanCode('kotlin', text);
    assert.ok(!masked.includes('import'));
    assert.ok(masked.includes('val after = 1'));
  });
});

describe('scanCode: Python and Ruby', () => {
  it('# comments, with the quote characters inside them ignored', () => {
    const { masked } = scanCode('python', lines("x = 1  # it's here", 'y = 2'));
    assert.ok(masked.includes('y = 2'));
    assert.ok(!masked.includes('here'));
  });

  it('triple-quoted strings (both quote kinds) are blanked across lines', () => {
    for (const q of ['"""', "'''"]) {
      const text = lines(`d = ${q}`, 'import neg', `${q}`, 'import real');
      const { masked } = scanCode('python', text);
      assert.ok(!masked.includes('neg'), q);
      assert.ok(masked.includes('import real'), q);
      assert.equal(masked.split('\n').length, 4);
    }
  });

  it('string prefixes (r, b, f, u and combinations, any case) are handled', () => {
    for (const prefix of ['r', 'b', 'f', 'u', 'rb', 'br', 'Rb', 'bR', 'fr', 'RF']) {
      const text = `x = ${prefix}'import neg'\nimport real`;
      const { masked } = scanCode('python', text);
      assert.ok(!masked.includes('neg'), prefix);
      assert.ok(masked.includes('import real'), prefix);
    }
  });

  it('f-string expression bodies are blanked too (documented, not modelled)', () => {
    const { masked } = scanCode('python', 'print(f"{value}")');
    assert.ok(!masked.includes('value'));
  });

  it('Ruby =begin / =end blocks and # comments are blanked', () => {
    const text = lines('a = 1', '=begin', "require 'neg'", '=end', "require 'real' # tail");
    const { masked, strings } = scanCode('ruby', text);
    assert.ok(!masked.includes('neg'));
    assert.ok(masked.includes('require'));
    assert.ok([...strings.values()].includes('real'));
    assert.ok(![...strings.values()].includes('neg'));
    assert.ok(!masked.includes('tail'));
  });
});

describe('scanCode: PHP', () => {
  it('only the inside of <?php ... ?> and <?= ... ?> is code; the rest is blanked', () => {
    const text = lines('HTML before', '<?php require "a.php"; ?>', 'HTML between', '<?= $x ?>', 'HTML after');
    const { masked } = scanCode('php', text);
    assert.ok(!masked.includes('HTML'));
    assert.ok(masked.includes('require'));
    assert.ok(masked.includes('$x'));
  });

  it('# and // and /* */ are comments inside PHP', () => {
    const text = lines('<?php', "# require 'a';", "// require 'b';", "/* require 'c'; */", "require 'real.php';");
    const { masked, strings } = scanCode('php', text);
    const contents = [...strings.values()];
    assert.deepEqual(contents, ['real.php']);
    assert.ok(masked.includes('require'));
  });

  it('an unclosed <?php block runs to EOF', () => {
    const { masked } = scanCode('php', "<?php require 'x.php';");
    assert.ok(masked.includes('require'));
  });
});

describe('scanCode: CSS family', () => {
  it('css has only block comments: `//` is NOT a comment', () => {
    const { masked } = scanCode('css', lines('a { x: 1 } // not a comment', '/* is */ b {}'));
    assert.ok(masked.includes('// not a comment'));
    assert.ok(!masked.includes('is */'));
  });

  it('scss and less also treat // as a comment', () => {
    for (const lang of ['scss', 'less'] as const) {
      const { masked } = scanCode(lang, lines('a { x: 1 } // a comment', 'b {}'));
      assert.ok(!masked.includes('comment'), lang);
      assert.ok(masked.includes('b {}'), lang);
    }
  });

  it('strings in url() and @import are exposed through the strings map', () => {
    const text = '@import "dir/file.css";';
    const { strings } = scanCode('css', text);
    assert.equal(strings.get(text.indexOf('"')), 'dir/file.css');
  });
});

describe('scanCode: HTML and Markdown', () => {
  it('html: only <!-- --> is blanked; attribute values stay readable', () => {
    const text = '<!-- <a href="neg.html"> --><a href="real.html">x</a>';
    const { masked } = scanCode('html', text);
    assert.ok(!masked.includes('neg.html'));
    assert.ok(masked.includes('href="real.html"'));
  });

  it('html: multi-line comments keep their newlines', () => {
    const { masked } = scanCode('html', lines('<!-- a', 'b -->', '<p>x</p>'));
    assert.equal(masked.split('\n').length, 3);
    assert.ok(masked.includes('<p>x</p>'));
  });

  it('markdown: fenced blocks (``` and ~~~), inline code and HTML comments are blanked; link syntax is kept', () => {
    const text = lines('[keep](./a.md)', '```js', '[x](./neg1.md)', '```', '~~~', '[y](./neg2.md)', '~~~', '`[z](./neg3.md)`', '<!-- [w](./neg4.md) -->', '[also](./b.md)');
    const { masked } = scanCode('markdown', text);
    assert.ok(masked.includes('[keep](./a.md)'));
    assert.ok(masked.includes('[also](./b.md)'));
    for (const n of ['neg1', 'neg2', 'neg3', 'neg4']) assert.ok(!masked.includes(n), n);
    assert.equal(masked.split('\n').length, text.split('\n').length);
  });

  it('markdown: an unterminated fence blanks to EOF', () => {
    const { masked } = scanCode('markdown', lines('[keep](./a.md)', '```', '[x](./neg.md)'));
    assert.ok(masked.includes('[keep](./a.md)'));
    assert.ok(!masked.includes('neg'));
  });
});
