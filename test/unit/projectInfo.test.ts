import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectInfo } from '../support/refs';
import { createMemFs } from '../support/memfs';
import { must } from '../support/fixtures';

describe('loadProjectInfo', () => {
  it('echoes the workspace roots', async () => {
    const fs = createMemFs({ '/ws/src/a.ts': '' });
    const info = await loadProjectInfo(fs, '/ws/src/a.ts', ['/ws']);
    assert.deepEqual(info.roots, ['/ws']);
    assert.equal(info.tsconfig, undefined);
    assert.equal(info.goModule, undefined);
    assert.equal(info.psr4, undefined);
  });

  it('reads tsconfig.json (JSONC): directory, absolute baseUrl and paths', async () => {
    const fs = createMemFs({
      '/ws/tsconfig.json': '{ /* c */ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["./*"], }, }, }',
      '/ws/src/a.ts': '',
    });
    const info = await loadProjectInfo(fs, '/ws/src/a.ts', ['/ws']);
    const ts = must(info.tsconfig, 'tsconfig');
    assert.equal(ts.dir, '/ws');
    assert.equal(ts.baseUrl, '/ws/src');
    assert.deepEqual(ts.paths, { '@/*': ['./*'] });
  });

  it('finds the nearest tsconfig walking up, not the first one at the root', async () => {
    const fs = createMemFs({
      '/ws/tsconfig.json': '{"compilerOptions":{"baseUrl":"."}}',
      '/ws/pkg/tsconfig.json': '{"compilerOptions":{"baseUrl":"lib"}}',
      '/ws/pkg/src/deep/a.ts': '',
    });
    const info = await loadProjectInfo(fs, '/ws/pkg/src/deep/a.ts', ['/ws']);
    assert.equal(must(info.tsconfig).baseUrl, '/ws/pkg/lib');
  });

  it('falls back to jsconfig.json', async () => {
    const fs = createMemFs({ '/ws/jsconfig.json': '{"compilerOptions":{"baseUrl":"."}}', '/ws/a.js': '' });
    const info = await loadProjectInfo(fs, '/ws/a.js', ['/ws']);
    assert.equal(must(info.tsconfig).baseUrl, '/ws');
  });

  it('reads go.mod for Go files (module path and directory)', async () => {
    const fs = createMemFs({ '/ws/go.mod': 'module example.com/app\n\ngo 1.22\n', '/ws/cmd/main.go': '' });
    const info = await loadProjectInfo(fs, '/ws/cmd/main.go', ['/ws']);
    assert.deepEqual(info.goModule, { dir: '/ws', modulePath: 'example.com/app' });
  });

  it('go.mod: nearest wins', async () => {
    const fs = createMemFs({
      '/ws/go.mod': 'module example.com/outer\n',
      '/ws/svc/go.mod': 'module example.com/svc\n',
      '/ws/svc/main.go': '',
    });
    const info = await loadProjectInfo(fs, '/ws/svc/main.go', ['/ws']);
    assert.deepEqual(info.goModule, { dir: '/ws/svc', modulePath: 'example.com/svc' });
  });

  it('reads composer.json psr-4 maps from autoload and autoload-dev as absolute directories', async () => {
    const fs = createMemFs({
      '/ws/composer.json': JSON.stringify({
        autoload: { 'psr-4': { 'App\\': 'src/', 'Lib\\': ['lib/', 'vendor-lib/'] } },
        'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
      }),
      '/ws/index.php': '',
    });
    const info = await loadProjectInfo(fs, '/ws/index.php', ['/ws']);
    const psr4 = must(info.psr4, 'psr4');
    const byPrefix = (p: string): string[] | undefined => {
      const key = Object.keys(psr4).find((k) => k.replace(/\\+$/, '') === p);
      return key === undefined ? undefined : psr4[key];
    };
    assert.deepEqual(byPrefix('App'), ['/ws/src']);
    assert.deepEqual(byPrefix('Tests'), ['/ws/tests']);
    assert.deepEqual(byPrefix('Lib')?.sort(), ['/ws/lib', '/ws/vendor-lib']);
  });

  it('malformed config files are tolerated', async () => {
    const fs = createMemFs({
      '/ws/tsconfig.json': '{{{{',
      '/ws/go.mod': '\u0000\u0001garbage',
      '/ws/composer.json': 'not json',
      '/ws/a.ts': '',
      '/ws/a.go': '',
      '/ws/a.php': '',
    });
    for (const f of ['/ws/a.ts', '/ws/a.go', '/ws/a.php']) {
      await assert.doesNotReject(loadProjectInfo(fs, f, ['/ws']), f);
    }
  });

  it('a file system that throws or rejects does not break project discovery', async () => {
    for (const opts of [{ throwOn: ['isFile', 'listDir', 'readText'] as const }, { rejectOn: ['isFile', 'listDir', 'readText'] as const }]) {
      const fs = createMemFs({ '/ws/a.ts': '' }, { ...opts });
      const info = await loadProjectInfo(fs, '/ws/a.ts', ['/ws']);
      assert.deepEqual(info.roots, ['/ws']);
    }
  });

  it('is bounded: a pathologically deep file path does not loop forever', async () => {
    const deep = '/ws/' + Array.from({ length: 200 }, (_, i) => `d${i}`).join('/') + '/a.ts';
    const fs = createMemFs({ [deep]: '' });
    await assert.doesNotReject(loadProjectInfo(fs, deep, ['/ws']));
  });
});
