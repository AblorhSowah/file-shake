// Property tests: random file trees and random import statements in every language. The analysis must never reject,
// and whatever it reports must be internally consistent and point at real, normalised, non-excluded workspace files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { run } from '../support/analyze';
import { K } from '../../src/core/constants';
import { hasSegment } from '../../src/core/pathUtils';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DIRS = ['', 'src', 'src/lib', 'src/lib/deep', 'app', 'pkg', 'pkg/sub', 'include', 'styles', 'docs', 'node_modules/dep'];
const STEMS = ['a', 'b', 'index', 'util', 'main', '_part', 'mod', 'x y', 'ünï', 'dot.name', 'UPPER'];
const EXTS: Record<string, string[]> = {
  ts: ['.ts', '.tsx', '.js', '.d.ts', '.json'],
  python: ['.py', '/__init__.py'],
  c: ['.h', '.hpp', '.c'],
  scss: ['.scss', '.css', '.less'],
  rust: ['.rs', '/mod.rs'],
  go: ['.go', '_test.go'],
  java: ['.java', '.kt'],
  ruby: ['.rb'],
  php: ['.php'],
  html: ['.html', '.js', '.css', '.png'],
  markdown: ['.md', '.png'],
};

interface Case {
  lang: keyof typeof EXTS;
  path: string;
  languageId: string;
  render: (spec: string) => string;
  /** specifier candidates that point at files of the random tree (the junk pool is mixed in separately) */
  derive: (files: string[]) => string[];
  junk: string[];
}

const RELS = ['./a', '../a', './src/b', '../src/lib/util', '.', '..', '/src/a', './x y', '../../../../../a', './dot.name', '.\\src\\b', './missing', 'pkg.mod', 'a.b.c', 'lodash', 'node:path', '', '   ', './' + 'z'.repeat(600), './a\u0000b', './a\nb', '~/a', '@/a', '#anchor', 'http://x/y', '//cdn/z', 'C:\\x\\y', '/etc/passwd', './node_modules/dep/index', '../node_modules/dep/a'];

const rel = (from: string, file: string): string => {
  const r = posix.relative(posix.dirname(from), file);
  return r.startsWith('.') ? r : `./${r}`;
};
const noExt = (p: string): string => p.replace(/\.(d\.ts|[a-z]+)$/i, '');
const only = (xs: string[], ...exts: string[]): string[] => xs.filter((f) => exts.some((e) => f.endsWith(e)));
const safe = (s: string): boolean => !s.includes('\n') && !s.includes('"') && !s.includes("'") && !s.includes('>') && !s.includes(')');

const CASES: Case[] = [
  { lang: 'ts', path: '/ws/src/main.ts', languageId: 'typescript', render: (s) => `import x from ${JSON.stringify(s)};\nconst y = require(${JSON.stringify(s)});\nimport(${JSON.stringify(s)});\nexport * from ${JSON.stringify(s)};\nx(y);`,
    derive: (fs) => fs.flatMap((f) => [rel('/ws/src/main.ts', noExt(f)), rel('/ws/src/main.ts', f), `@/${posix.relative('/ws/src', noExt(f))}`, `/${posix.relative('/ws', noExt(f))}`]), junk: RELS },
  { lang: 'python', path: '/ws/app/main.py', languageId: 'python', render: (s) => `import ${s || '_'}\nfrom ${s || '.'} import a, b as c\nfrom ${s || '.'} import *\n`,
    derive: (fs) => only(fs, '.py').flatMap((f) => [posix.relative('/ws', noExt(f)).replace(/\/__init__$/, '').replace(/\//g, '.'), '.' + posix.relative('/ws/app', noExt(f)).replace(/\//g, '.')]), junk: ['a', 'pkg.mod', '.util', '..pkg', '...', 'a.b.c', 'os', '.a.b', 'ünï', '1bad', '....................'] },
  { lang: 'c', path: '/ws/src/main.c', languageId: 'c', render: (s) => `#include "${s}"\n#include <${s}>\n`,
    derive: (fs) => only(fs, '.h', '.hpp').flatMap((f) => [rel('/ws/src/main.c', f), posix.basename(f), posix.relative('/ws/include', f)]).filter(safe), junk: RELS.filter(safe) },
  { lang: 'scss', path: '/ws/styles/main.scss', languageId: 'scss', render: (s) => `@use "${s}";\n@import "${s}", "${s}";\n@forward "${s}";\n`,
    derive: (fs) => fs.flatMap((f) => [rel('/ws/styles/main.scss', noExt(f).replace(/(^|\/)_/, '$1')), rel('/ws/styles/main.scss', f)]).filter(safe), junk: RELS.filter(safe) },
  { lang: 'rust', path: '/ws/src/lib.rs', languageId: 'rust', render: (s) => `mod ${s.replace(/\W/g, '_') || 'm'};\nuse crate::${s.replace(/\W+/g, '::') || 'a'}::T;\nuse self::${s.replace(/\W/g, '_') || 'a'};\nuse super::${s.replace(/\W/g, '_') || 'a'}::U;\n`,
    derive: (fs) => only(fs, '.rs').flatMap((f) => [posix.basename(noExt(f)).replace(/\W/g, '_'), posix.relative('/ws/src', noExt(f)).replace(/\/mod$/, '')]), junk: ['a', 'b', 'mod', 'util', 'a/b', 'x y', 'pkg', 'sub'] },
  { lang: 'go', path: '/ws/main.go', languageId: 'go', render: (s) => `package main\nimport "${s}"\nimport alias "${s}"\n`,
    derive: (fs) => only(fs, '.go').map((f) => `example.com/app/${posix.dirname(posix.relative('/ws', f))}`).filter((s2) => !s2.endsWith('/.')), junk: ['example.com/app', 'example.com/application/x', 'fmt', 'example.com/app/../x'] },
  { lang: 'java', path: '/ws/src/main/java/com/x/Main.java', languageId: 'java', render: (s) => `package com.x;\nimport ${s};\nimport static ${s}.m;\nimport ${s}.*;\n`,
    derive: (fs) => only(fs, '.java', '.kt').map((f) => `com.x.${posix.basename(noExt(f)).replace(/\W/g, '_')}`), junk: ['a', 'java.util.List', 'com.x.A.Inner', 'x.y.z.w.v.u'] },
  { lang: 'ruby', path: '/ws/lib/main.rb', languageId: 'ruby', render: (s) => `require_relative '${s}'\nrequire '${s}'\nload '${s}'\nautoload :S, '${s}'\n`,
    derive: (fs) => only(fs, '.rb').flatMap((f) => [rel('/ws/lib/main.rb', noExt(f)), posix.relative('/ws', noExt(f)), posix.basename(noExt(f))]).filter(safe), junk: RELS.filter(safe) },
  { lang: 'php', path: '/ws/index.php', languageId: 'php', render: (s) => `<?php\nrequire '${s}';\nuse App\\${s.replace(/\W/g, '')};\n`,
    derive: (fs) => only(fs, '.php').flatMap((f) => [posix.relative('/ws', f), `./${posix.relative('/ws', f)}`]).filter(safe), junk: RELS.filter(safe) },
  { lang: 'html', path: '/ws/docs/index.html', languageId: 'html', render: (s) => `<a href="${s}">x</a><img src='${s}'><script src=${s.replace(/\s/g, '')}></script>`,
    derive: (fs) => only(fs, '.html', '.js', '.css', '.png').flatMap((f) => [rel('/ws/docs/index.html', f), `/${posix.relative('/ws', f)}`, `${posix.relative('/ws/docs', f)}?v=1#top`]).filter(safe), junk: RELS.filter(safe) },
  { lang: 'markdown', path: '/ws/docs/index.md', languageId: 'markdown', render: (s) => `[t](${s.replace(/[()\s]/g, '')})\n![i](${s.replace(/[()\s]/g, '')})\n[r]: ${s.replace(/\s/g, '')}\n`,
    derive: (fs) => only(fs, '.md', '.png').flatMap((f) => [rel('/ws/docs/index.md', f), rel('/ws/docs/index.md', noExt(f)), `/${posix.relative('/ws', f)}`]).filter(safe), junk: RELS.filter(safe) },
];

function randomTree(r: () => number, lang: keyof typeof EXTS): Record<string, string> {
  const files: Record<string, string> = {
    '/ws/go.mod': 'module example.com/app\n',
    '/ws/composer.json': '{"autoload":{"psr-4":{"App\\\\":"src/"}}}',
    '/ws/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  };
  const n = 10 + Math.floor(r() * 40);
  const exts = EXTS[lang] ?? ['.txt'];
  for (let i = 0; i < n; i++) {
    const dir = DIRS[Math.floor(r() * DIRS.length)] as string;
    const stem = STEMS[Math.floor(r() * STEMS.length)] as string;
    const ext = exts[Math.floor(r() * exts.length)] as string;
    files[`/ws/${dir ? `${dir}/` : ''}${stem}${ext}`] = '';
  }
  for (let i = 0; i < 6; i++) files[`/ws/src/main/java/com/x/${STEMS[Math.floor(r() * STEMS.length)]?.replace(/\W/g, '_')}.java`] = '';
  return files;
}

describe('analyzeReferences: invariants over random trees and random import statements (11 language families)', () => {
  for (const c of CASES) {
    it(`${c.lang}: 120 random cases`, async () => {
      const r = prng(0xc0ffee ^ (c.lang.charCodeAt(0) << 8) ^ c.path.length);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      let found = 0;
      for (let round = 0; round < 120; round++) {
        const files = randomTree(r, c.lang);
        const derived = c.derive(Object.keys(files));
        const specs = [...derived, ...derived, ...derived, ...c.junk];
        let text = '';
        for (let k = 0, n = 1 + Math.floor(r() * 6); k < n; k++) text += `${c.render(pick(specs))}\n${r() < 0.5 ? 'a(); b(); c(); x(y);\n' : ''}`;
        const excluded = (key: string): boolean => r() < 0.0 && key.length > 0; // placeholder for deterministic exclusion below
        void excluded;
        const isExcluded = (key: string): boolean => key.includes('/styles/') && key.endsWith('.less');
        const { result } = await run(files, c.path, text, { languageId: c.languageId, isExcluded });
        const where = `${c.lang} round ${round}\n${text}`;

        found += result.targets.length;
        assert.ok(result.targets.length <= K.MAX_REFS_PER_SOURCE, where);
        assert.ok(Number.isInteger(result.unresolved) && result.unresolved >= 0, where);
        assert.ok(Number.isFinite(result.parseMs) && result.parseMs >= 0, where);
        const keys = new Set<string>();
        let prev: { count: number; key: string } | undefined;
        for (const t of result.targets) {
          assert.ok(!keys.has(t.key), `duplicate target ${t.key}\n${where}`);
          keys.add(t.key);
          assert.ok(t.key in files, `target ${t.key} is not a file of the tree\n${where}`);
          assert.notEqual(t.key, c.path, `self reference\n${where}`);
          assert.ok(!hasSegment(t.key, 'node_modules'), `${t.key}\n${where}`);
          assert.ok(!isExcluded(t.key), `excluded target ${t.key}\n${where}`);
          assert.ok(!t.key.includes('\\') && !/(^|\/)\.\.?(\/|$)/.test(t.key) && !t.key.includes('//'), `unnormalised key ${t.key}`);
          assert.ok(t.statements >= 1 && Number.isInteger(t.statements), where);
          assert.ok(Number.isInteger(t.usages) && t.usages >= 0, where);
          assert.equal(t.count, t.statements + t.usages, `${t.key}\n${where}`);
          assert.ok(t.lines.length >= 1 && t.lines.every((l) => Number.isInteger(l) && l >= 1), where);
          assert.ok(t.specifiers.length >= 1 && t.specifiers.every((s) => s.length > 0 && s.length <= 512 && !s.includes('\u0000') && !s.includes('\n')), where);
          if (prev) assert.ok(prev.count > t.count || (prev.count === t.count && prev.key < t.key), `order ${prev.key}(${prev.count}) before ${t.key}(${t.count})`);
          prev = t;
        }
        // deterministic: the same input gives the same output
        const again = (await run(files, c.path, text, { languageId: c.languageId, isExcluded })).result;
        assert.deepEqual({ ...again, parseMs: 0 }, { ...result, parseMs: 0 }, where);
      }
      assert.ok(found >= 20, `the property test must actually resolve things (${found} targets in 120 rounds)`);
    });
  }
});
