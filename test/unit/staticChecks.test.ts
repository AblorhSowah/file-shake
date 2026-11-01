import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importsOf, listTsFiles, read, rel, runtimeClosure, strip } from '../support/staticScan';
import { REPO_ROOT } from '../support/fixtures';

const core = listTsFiles('src/core');
const webview = listTsFiles('src/webview');
const vscodeSrc = listTsFiles('src/vscode');
const extensionTs = existsSync(join(REPO_ROOT, 'src', 'extension.ts')) ? [join(REPO_ROOT, 'src', 'extension.ts')] : [];
const allSrc = [...core, ...webview, ...vscodeSrc, ...extensionTs];

const offenders = (files: string[], test: (code: string, raw: string, file: string) => string[]): string[] =>
  files.flatMap((f) => {
    const raw = read(f);
    return test(strip(raw, { strings: true }), raw, f).map((m) => `${rel(f)}: ${m}`);
  });

describe('static policy: src/core is pure (DESIGN 3.1 / 4)', () => {
  it('there are core files to check', () => assert.ok(core.length >= 15, `found ${core.length}`));

  it('core imports neither vscode nor any node builtin', () => {
    const bad = core.flatMap((f) =>
      importsOf(read(f))
        .filter((i) => i.spec === 'vscode' || i.spec.startsWith('node:') || ['fs', 'path', 'os', 'child_process', 'crypto', 'util', 'url', 'worker_threads', 'perf_hooks'].includes(i.spec))
        .map((i) => `${rel(f)} imports ${i.spec}`),
    );
    assert.deepEqual(bad, []);
  });

  it('core does not use process, require(), __dirname or Buffer', () => {
    const bad = offenders(core, (code) => [/\bprocess\./, /\brequire\(/, /__dirname|__filename/, /\bBuffer\b/].filter((re) => re.test(code)).map((re) => `matches ${re}`));
    assert.deepEqual(bad, []);
  });

  it('core reads no clock directly except clock.ts and the analysis entry point (time is injected)', () => {
    // types.ts only declares the Scheduler interface (a `setTimeout` method signature)
    const allowed = new Set(['src/core/clock.ts', 'src/core/types.ts', 'src/core/references/index.ts']);
    const bad = core
      .filter((f) => !allowed.has(rel(f)))
      .flatMap((f) => {
        const code = strip(read(f), { strings: true });
        return [/\bDate\.now\b/, /\bnew Date\b/, /\bperformance\.now\b/, /(?<!\.)\bsetTimeout\s*\(/, /(?<!\.)\bsetInterval\s*\(/].filter((re) => re.test(code)).map((re) => `${rel(f)} matches ${re}`);
      });
    assert.deepEqual(bad, []);
  });

  it('clock.ts types its timer handles with ReturnType<typeof setTimeout> (compiles under both node and DOM libs)', () => {
    const src = read(join(REPO_ROOT, 'src', 'core', 'clock.ts'));
    assert.ok(!/NodeJS\.Timeout/.test(src));
    assert.ok(!/:\s*number\s*=\s*setTimeout|window\.setTimeout/.test(src));
  });
});

describe('static policy: the webview bundle', () => {
  const entries = webview.filter((f) => /\/(main|app)\.ts$/.test(f));

  it('app.ts and main.ts exist', () => {
    assert.deepEqual(entries.map(rel).sort(), ['src/webview/app.ts', 'src/webview/main.ts']);
  });

  it('its runtime import closure contains only the allowed core modules and no external package', () => {
    const allowedCore = new Set(['types', 'constants', 'intensity', 'protocol', 'tree', 'webviewHtml', 'pathUtils', 'clock'].map((n) => `src/core/${n}.ts`));
    for (const entry of entries) {
      const { files, externals } = runtimeClosure(entry);
      assert.deepEqual(externals, [], `${rel(entry)} pulls external packages into the browser bundle`);
      for (const f of files) {
        const r = rel(f);
        if (r.startsWith('src/webview/')) continue;
        assert.ok(allowedCore.has(r), `${rel(entry)} reaches ${r}, which must not be in the browser bundle`);
      }
    }
  });

  it('never imports vscode or node builtins', () => {
    const bad = webview.flatMap((f) => importsOf(read(f)).filter((i) => i.spec === 'vscode' || i.spec.startsWith('node:')).map((i) => `${rel(f)} imports ${i.spec}`));
    assert.deepEqual(bad, []);
  });

  it('uses no HTML sinks: innerHTML, outerHTML, insertAdjacentHTML, document.write, createContextualFragment, DOMParser', () => {
    const bad = offenders(webview, (code) =>
      [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bcreateContextualFragment\b/, /\bDOMParser\b/].filter((re) => re.test(code)).map((re) => `matches ${re}`),
    );
    assert.deepEqual(bad, []);
  });

  it('never writes a style attribute or cssText; only style.setProperty', () => {
    const bad = offenders(webview, (_code, raw) => {
      const code = strip(raw, { strings: false });
      return [/setAttribute\(\s*['"]style['"]/i, /\.cssText\b/, /\.setAttribute\(\s*['"]on/i, /\.style\.[a-zA-Z]+\s*=[^=]/].filter((re) => re.test(code)).map((re) => `matches ${re}`);
    });
    assert.deepEqual(bad, []);
  });

  it('no eval / new Function / string timers / remote URLs', () => {
    const bad = offenders(webview, (_code, raw) => {
      const code = strip(raw, { strings: false });
      return [/\beval\s*\(/, /new Function\s*\(/, /setTimeout\(\s*['"`]/, /https?:\/\//, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /importScripts/].filter((re) => re.test(code)).map((re) => `matches ${re}`);
    });
    assert.deepEqual(bad, []);
  });

  it('main.ts talks to the host only through acquireVsCodeApi + message events', () => {
    const main = read(join(REPO_ROOT, 'src', 'webview', 'main.ts'));
    assert.ok(/acquireVsCodeApi\s*\(/.test(main));
    assert.ok(/addEventListener\(\s*['"]message['"]/.test(main));
  });
});

describe('static policy: TypeScript hygiene across src', () => {
  it('there are source files to check', () => assert.ok(allSrc.length >= 20, `found ${allSrc.length}`));

  it('no `any` type anywhere in src', () => {
    const bad = offenders(allSrc, (code) => {
      const hits: string[] = [];
      const re = /(?::|<|,|\bas\b|\|\||\|)\s*any\b|\bany\s*(?:\[\]|>)|<any\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) hits.push(JSON.stringify(code.slice(Math.max(0, m.index - 20), m.index + 20)));
      return hits;
    });
    assert.deepEqual(bad, []);
  });

  it('no ts-ignore / ts-nocheck / eslint-disable escape hatches without a reason', () => {
    const bad = offenders(allSrc, (_code, raw) => [/@ts-ignore/, /@ts-nocheck/, /eslint-disable(?!-next-line [\w@/-]+ -- )/].filter((re) => re.test(raw)).map((re) => `matches ${re}`));
    assert.deepEqual(bad, []);
  });

  it('no inline CSP relaxations or inline handlers are generated anywhere', () => {
    const bad = offenders(allSrc, (_code, raw) => {
      const code = strip(raw, { strings: false });
      return [/unsafe-inline/, /unsafe-eval/, /<[a-z][^>]*\son[a-z]+\s*=/i, /setAttribute\(\s*['"]on/i].filter((re) => re.test(code)).map((re) => `matches ${re}`);
    });
    assert.deepEqual(bad, []);
  });

  it('no setInterval anywhere (the tick is a self-stopping setTimeout chain: zero timers when idle)', () => {
    const bad = offenders(allSrc, (code) => (/\bsetInterval\b/.test(code) ? ['uses setInterval'] : []));
    assert.deepEqual(bad, []);
  });

  it('no synchronous file-system calls in the extension host code', () => {
    const files = [...vscodeSrc, ...extensionTs];
    const bad = offenders(files, (code) => (/\b(readFileSync|writeFileSync|statSync|lstatSync|existsSync|readdirSync|mkdirSync|accessSync|realpathSync|openSync)\b/.test(code) ? ['uses a synchronous fs API'] : []));
    assert.deepEqual(bad, []);
  });

  it('adapters read time only through the injected Clock / Scheduler (no Date.now / direct timers in src/vscode)', () => {
    const bad = offenders(vscodeSrc, (code) => [/\bDate\.now\b/, /\bnew Date\b/, /(?<!\.)\bsetTimeout\s*\(/, /(?<!\.)\bsetInterval\s*\(/].filter((re) => re.test(code)).map((re) => `matches ${re}`));
    assert.deepEqual(bad, [], 'every timer must go through core/clock so the test seam can drive it and idle means zero timers');
  });

  it('src/vscode and extension.ts are the only places that import vscode', () => {
    const bad = [...core, ...webview].flatMap((f) => importsOf(read(f)).filter((i) => i.spec === 'vscode').map(() => `${rel(f)} imports vscode`));
    assert.deepEqual(bad, []);
  });

  it('src/extension.ts is wiring only: it registers every disposable through context.subscriptions', () => {
    if (extensionTs.length === 0) assert.fail('src/extension.ts does not exist yet');
    const src = read(join(REPO_ROOT, 'src', 'extension.ts'));
    assert.ok(/export\s+(async\s+)?function\s+activate\b/.test(src));
    assert.ok(/export\s+function\s+deactivate\b/.test(src));
    assert.ok(/context\.subscriptions/.test(src));
  });
});

describe('static policy: commands declared in package.json are registered in code', () => {
  it('every contributed command id appears in src (registerCommand) and no unlisted fileShake.* command is registered', () => {
    const pkg = JSON.parse(read(join(REPO_ROOT, 'package.json'))) as { contributes: { commands: Array<{ command: string }> } };
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    const src = allSrc.map((f) => strip(read(f), { strings: false })).join('\n');
    for (const id of declared) assert.ok(src.includes(`'${id}'`) || src.includes(`"${id}"`), `${id} is declared but never mentioned in src`);
    const registered = [...src.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
    const stray = registered.filter((id) => id.startsWith('fileShake.') && !declared.includes(id));
    assert.deepEqual(stray, [], 'commands registered but not contributed in package.json');
  });
});
