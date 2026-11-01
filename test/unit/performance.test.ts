import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { countUsages, parseImports, scanCode } from '../support/refs';
import { run } from '../support/analyze';
import { REPO_ROOT } from '../support/fixtures';
import { ActivityTracker } from '../../src/core/activityTracker';
import { ManualClock } from '../../src/core/clock';
import { buildRows } from '../../src/core/viewModel';
import { buildTree } from '../../src/core/tree';
import { buildDecorations } from '../../src/core/decorations';
import { parseHostMessage } from '../../src/core/protocol';
import { snapshotOf, trackedFile, viewRow } from '../support/builders';
import { K } from '../../src/core/constants';
import type { ImportBinding } from '../support/types';

/** Best (minimum) wall time of `n` runs: robust against one-off scheduler noise. */
function bestOf(n: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** About 5,000 lines / 200 KB of realistic TypeScript with imports, comments, strings and templates. */
function bigTsFile(): { text: string; bindings: ImportBinding[] } {
  const lines: string[] = [];
  const bindings: ImportBinding[] = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`import { name${i}, other${i} as alias${i} } from './module${i}';`);
    bindings.push({ local: `name${i}`, imported: `name${i}` }, { local: `alias${i}`, imported: `other${i}` });
  }
  lines.push("import * as everything from './everything';", "const fs = require('node:fs');");
  bindings.push({ local: 'everything', imported: '*' });
  let n = 0;
  while (lines.length < 5000) {
    const k = n++ % 8;
    const i = n % 60;
    switch (k) {
      case 0:
        lines.push(`export const h${n} = () => name${i}(${n});`);
        break;
      case 1:
        lines.push(`// c${n}: name${i} import './x' require('y')`);
        break;
      case 2:
        lines.push(`const m${n} = \`v \${name${i}} 'q' "d"\`;`);
        break;
      case 3:
        lines.push(`const d${n} = { k: 'v${n}', n: alias${i} };`);
        break;
      case 4:
        lines.push(`/* b${n} name${i} */ const x${n} = e.t / 2;`);
        break;
      case 5:
        lines.push(`if (name${i}) { log('l${n}', alias${i}); }`);
        break;
      case 6:
        lines.push(`const r${n} = /ab+c/g; t.replace(r${n}, "y");`);
        break;
      default:
        lines.push(`export const v${n}: number = ${n} * (name${i} ? 1 : 0);`);
    }
  }
  return { text: lines.join('\n'), bindings };
}

describe('performance: reference parsing (DESIGN 8.7)', () => {
  const { text, bindings } = bigTsFile();

  it('the generated file is about 5,000 lines / 200 KB', () => {
    assert.ok(text.split('\n').length >= 5000);
    assert.ok(text.length > 150_000 && text.length < 300_000, `size ${text.length}`);
  });

  it('scanCode + parseImports + countUsages on 5,000 lines: <= 400 ms (target 150 ms)', () => {
    const ms = bestOf(3, () => {
      const scan = scanCode('ts', text);
      const stmts = parseImports('ts', text);
      countUsages(scan.masked, bindings, new Set<number>(stmts.map((s) => s.line)));
    });
    assert.ok(ms <= 400, `took ${ms.toFixed(1)} ms`);
  });

  it('the file really contains the expected imports (the benchmark does real work)', () => {
    const stmts = parseImports('ts', text);
    assert.equal(stmts.filter((s) => s.specifier.startsWith('./module')).length, 60);
    assert.ok(stmts.some((s) => s.specifier === 'node:fs'));
    assert.ok(!stmts.some((s) => s.specifier === './not-real' || s.specifier === 'also-not-real'));
    const scan = scanCode('ts', text);
    assert.ok(countUsages(scan.masked, bindings, new Set<number>(stmts.map((s) => s.line))) > 1000);
  });

  it('full analyzeReferences (parse + resolve + count) on the same file stays fast with an in-memory fs', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`/ws/module${i}.ts`] = '';
    files['/ws/everything.ts'] = '';
    const t0 = performance.now();
    const { result } = await run(files, '/ws/main.ts', text);
    const ms = performance.now() - t0;
    assert.ok(ms <= 1000, `analyzeReferences took ${ms.toFixed(1)} ms`);
    assert.equal(result.targets.length, K.MAX_REFS_PER_SOURCE);
    assert.equal(result.truncated, true);
  });

  it('other languages scale linearly on 5,000 lines too (python, c, css, html)', () => {
    const py = Array.from({ length: 5000 }, (_, i) => (i % 5 === 0 ? `from pkg.mod${i} import thing${i}, other${i} as o${i}` : `value_${i} = thing${i - (i % 5)}(o${i - (i % 5)}) + "import neg"  # import x`)).join('\n');
    const c = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `#include "header${i}.h"` : `int f${i}(void) { return ${i}; } // #include "no.h"`)).join('\n');
    const css = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `@import "part${i}";` : `.cls${i} { color: red; } /* @import "no" */`)).join('\n');
    const html = Array.from({ length: 5000 }, (_, i) => `<div class="c${i}"><a href="page${i}.html">link ${i}</a><img src="img${i}.png"></div>`).join('\n');
    for (const [lang, src] of [['python', py], ['c', c], ['scss', css], ['html', html]] as const) {
      const ms = bestOf(3, () => {
        scanCode(lang, src);
        parseImports(lang, src);
      });
      assert.ok(ms <= 400, `${lang}: ${ms.toFixed(1)} ms`);
    }
  });
});

describe('performance: pathological inputs (500 KB, hard timeout, child process)', () => {
  it('no language x pattern combination takes more than 1000 ms, throws, or hangs', { timeout: 240_000 }, () => {
    const runner = join(REPO_ROOT, 'test', 'support', 'pathologicalRunner.ts');
    const res = spawnSync(process.execPath, ['--import', 'tsx', runner], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 200_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = res.stdout.split('\n').filter((l) => l.startsWith('{'));
    const rows = out.map((l) => JSON.parse(l) as { lang: string; pattern: string; ms: number; ok: boolean; error: string });
    const expectedRuns = 16 * 32;
    if (res.error || res.status !== 0) {
      const last = rows[rows.length - 1];
      assert.fail(
        `pathological runner did not finish (status ${String(res.status)}, signal ${String(res.signal)}, error ${String(res.error)}); ` +
          `completed ${rows.length}/${expectedRuns}; last finished: ${last ? `${last.lang}/${last.pattern}` : 'none'}; the NEXT combination is the one that hangs. stderr: ${res.stderr.slice(0, 500)}`,
      );
    }
    assert.equal(rows.length, expectedRuns);
    const failed = rows.filter((r) => !r.ok);
    assert.deepEqual(failed.map((r) => `${r.lang}/${r.pattern}: ${r.error}`), [], 'no combination may throw');
    const slow = rows.filter((r) => r.ms > 1000);
    assert.deepEqual(slow.map((r) => `${r.lang}/${r.pattern}: ${r.ms} ms`), [], 'budget is 1000 ms per combination');
  });
});

describe('performance: tracker and view model', () => {
  it('DESIGN 12: 200 rapid edits on one file stay within 20 ms total (best of 5)', () => {
    const ms = bestOf(5, () => {
      const clock = new ManualClock(1_000_000);
      const tracker = new ActivityTracker(clock);
      for (let i = 0; i < 200; i++) {
        tracker.record({ key: '/ws/a.ts', source: 'you', weight: 1 });
        clock.advance(5);
        tracker.get('/ws/a.ts');
      }
      tracker.snapshot();
    });
    assert.ok(ms <= 20, `200 edits took ${ms.toFixed(2)} ms`);
  });

  it('200 edits spread over 40 files, with a snapshot after each, stay within 100 ms', () => {
    const ms = bestOf(3, () => {
      const clock = new ManualClock(1_000_000);
      const tracker = new ActivityTracker(clock);
      for (let i = 0; i < 200; i++) {
        tracker.record({ key: `/ws/f${i % 40}.ts`, source: i % 7 === 0 ? 'external' : 'you', weight: 1 + (i % 5) });
        clock.advance(7);
        tracker.snapshot();
      }
    });
    assert.ok(ms <= 100, `took ${ms.toFixed(2)} ms`);
  });

  it('10,000 events on one file do not slow later calls (memory/time bounded by MAX_EVENTS_PER_FILE)', () => {
    const clock = new ManualClock(1_000_000);
    const tracker = new ActivityTracker(clock);
    for (let i = 0; i < 10_000; i++) tracker.record({ key: '/ws/a.ts', source: 'you', weight: 1 });
    const ms = bestOf(5, () => {
      for (let i = 0; i < 200; i++) tracker.get('/ws/a.ts');
    });
    assert.ok(ms <= 50, `200 gets after 10k events took ${ms.toFixed(2)} ms`);
  });

  it('a 40-file model refresh (rows + tree + decorations) is cheap enough for a 200 ms tick (<= 20 ms)', () => {
    const tracked = Array.from({ length: 40 }, (_, i) => trackedFile(`/ws/dir${i % 6}/file${i}.ts`, { lastEditAt: 10_000 - i }));
    const refs = new Map(
      tracked.slice(0, 3).map((t) => [
        t.key,
        { source: t.key, language: 'ts' as const, targets: Array.from({ length: 30 }, (_, j) => ({ key: `/ws/lib/r${j}.ts`, count: j + 1, statements: 1, usages: j, lines: [1], specifiers: ['./x'] })), truncated: false, unresolved: 0, parseMs: 1 },
      ]),
    );
    const ms = bestOf(5, () => {
      const rows = buildRows({ tracked, references: refs, roots: [{ key: '/ws', name: 'ws' }], toUri: (k) => `file://${k}`, sensitivity: 1, maxFiles: 40, showWhenIdle: false });
      buildTree(rows);
      buildDecorations(rows, { showWhenIdle: false, decorateFolders: true });
    });
    assert.ok(ms <= 20, `refresh took ${ms.toFixed(2)} ms`);
  });

  it('parseHostMessage validates a 500-row snapshot quickly (<= 30 ms)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => JSON.parse(JSON.stringify(viewRow(`/ws/d${i % 9}/f${i}.ts`))) as unknown);
    const msg = { type: 'snapshot', snapshot: { ...snapshotOf([]), rows } };
    const ms = bestOf(5, () => {
      assert.ok(parseHostMessage(msg));
    });
    assert.ok(ms <= 30, `took ${ms.toFixed(2)} ms`);
  });
});
