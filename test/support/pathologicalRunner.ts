// Child-process runner for the pathological-input performance test (test/unit/performance.test.ts).
// It runs in its own process so a catastrophic regex cannot hang the whole test run: the parent
// enforces a hard timeout and kills it. Prints one JSON line per (language, pattern).
import { countUsages, parseImports, scanCode } from './refs';
import type { LanguageKey } from './types';

interface Pattern {
  name: string;
  text: string;
}

const SIZE = 500_000;
const rep = (s: string): string => s.repeat(Math.ceil(SIZE / s.length)).slice(0, SIZE);

const patterns: Pattern[] = [
  { name: 'open-parens', text: rep('(') },
  { name: 'open-braces', text: rep('{') },
  { name: 'backslashes', text: rep('\\') },
  { name: 'quote-soup', text: rep('"a') },
  { name: 'single-quote-soup', text: rep("'a") },
  { name: 'import-keyword-only', text: rep('import ') },
  { name: 'import-open-brace', text: rep('import {') },
  { name: 'require-open', text: rep('require(') },
  { name: 'dynamic-import-open', text: rep('import(') },
  { name: 'unterminated-comments', text: rep('/*') },
  { name: 'template-nesting', text: rep('`${') },
  { name: 'one-long-identifier', text: rep('a') },
  { name: 'long-whitespace-then-from', text: 'import a ' + ' '.repeat(SIZE) + "from 'x'" },
  { name: 'whitespace-then-import', text: ' '.repeat(SIZE) + 'import' },
  { name: 'long-import-list', text: 'import {' + rep(' a,') + "} from 'x';" },
  { name: 'python-from-import', text: rep('from . import ') },
  { name: 'python-continuations', text: rep('import a, \\\n') },
  { name: 'python-triple-quotes', text: rep('"""') },
  { name: 'c-include-open', text: rep('#include "') },
  { name: 'c-include-angle', text: rep('#include <') },
  { name: 'html-open-attrs', text: rep('<a href=') },
  { name: 'html-open-comments', text: rep('<!--') },
  { name: 'markdown-link-open', text: rep('[](') },
  { name: 'markdown-fences', text: rep('```\n') },
  { name: 'css-import-open', text: rep('@import url(') },
  { name: 'rust-use-open', text: rep('use a::{') },
  { name: 'rust-raw-strings', text: rep('r#"') },
  { name: 'rust-lifetimes', text: rep("'a ") },
  { name: 'go-grouped-open', text: 'import (' + rep('"a"\n') },
  { name: 'php-open-tags', text: rep('<?php ') },
  { name: 'ruby-begin-end', text: rep('=begin\n') },
  { name: 'lines-of-imports', text: rep("import a from 'b';\n") },
];

const langs: LanguageKey[] = ['ts', 'js', 'python', 'go', 'java', 'kotlin', 'c', 'cpp', 'rust', 'ruby', 'php', 'css', 'scss', 'less', 'html', 'markdown'];

for (const lang of langs) {
  for (const p of patterns) {
    const t0 = performance.now();
    let ok = true;
    let error = '';
    try {
      scanCode(lang, p.text);
      const stmts = parseImports(lang, p.text);
      const bindings = stmts.flatMap((s) => s.bindings).slice(0, 50);
      const masked = scanCode(lang, p.text).masked;
      countUsages(masked, bindings, new Set<number>());
    } catch (e) {
      ok = false;
      error = String(e);
    }
    const ms = performance.now() - t0;
    process.stdout.write(`${JSON.stringify({ lang, pattern: p.name, ms: Math.round(ms), ok, error })}\n`);
  }
}
