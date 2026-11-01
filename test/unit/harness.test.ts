import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TEST_USER_SETTINGS,
  VARIANTS,
  copyFixtureTree,
  makeShortTempDir,
  prepareLayout,
  repoRoot,
  scrubEnv,
  selectSuiteFiles,
  variantOfSuiteFile,
} from '../integration/harness';
import { REPO_ROOT, fixturePath, readRepoFile } from '../support/fixtures';

describe('integration harness: environment scrubbing (DESIGN 13 trap)', () => {
  it('removes ELECTRON_RUN_AS_NODE and every VSCODE_* variable, and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_PID: '123',
      VSCODE_IPC_HOOK: '/tmp/x.sock',
      VSCODE_TEST_VERSION: '1.85.0',
      VSCODE_NLS_CONFIG: '{}',
      PATH: '/usr/bin',
      HOME: '/home/u',
      FS_VSCODE_EXE: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      NOT_VSCODE_X: 'keep',
      vscode_lower: 'keep (case sensitive prefix)',
      FILE_SHAKE_TEST: '1',
    };
    const removed = scrubEnv(env);
    assert.deepEqual(removed, ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_NLS_CONFIG', 'VSCODE_PID', 'VSCODE_TEST_VERSION']);
    assert.deepEqual(Object.keys(env).sort(), ['FILE_SHAKE_TEST', 'FS_VSCODE_EXE', 'HOME', 'NOT_VSCODE_X', 'PATH', 'vscode_lower']);
  });

  it('is a no-op on a clean environment', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' };
    assert.deepEqual(scrubEnv(env), []);
    assert.deepEqual(env, { PATH: '/bin' });
  });

  it('the executable override is deliberately NOT a VSCODE_* name (it would be scrubbed)', () => {
    assert.ok(!'FS_VSCODE_EXE'.startsWith('VSCODE_'));
    const env: NodeJS.ProcessEnv = { FS_VSCODE_EXE: '/x' };
    scrubEnv(env);
    assert.equal(env['FS_VSCODE_EXE'], '/x');
  });
});

describe('integration harness: runTest.ts source-level guards', () => {
  const src = readRepoFile('test', 'integration', 'runTest.ts');

  it('scrubs process.env before launching, after reading its own VSCODE_TEST_VERSION input', () => {
    const scrubAt = src.indexOf('scrubEnv(process.env)');
    const versionAt = src.indexOf("process.env['VSCODE_TEST_VERSION']");
    const launchAt = src.indexOf('await runTests(');
    assert.ok(scrubAt > 0 && versionAt > 0 && launchAt > 0);
    assert.ok(versionAt < scrubAt, 'VSCODE_TEST_VERSION must be read before the scrub deletes it');
    assert.ok(scrubAt < launchAt);
  });

  it('honours FS_VSCODE_EXE and only falls back to a download-capable `version` when it is unset', () => {
    assert.match(src, /process\.env\['FS_VSCODE_EXE'\]/);
    assert.match(src, /vscodeExecutablePath:\s*exe/);
    assert.ok(!/downloadAndUnzipVSCode/.test(src), 'the harness must never download VS Code explicitly');
  });

  it('installed-copy mode: FS_INSTALLED_VSIX needs FS_VSCODE_EXE, installs into the isolated extensions dir, and keeps extensions enabled', () => {
    assert.match(src, /process\.env\['FS_INSTALLED_VSIX'\]/);
    assert.match(src, /FS_INSTALLED_VSIX needs FS_VSCODE_EXE/);
    assert.match(src, /'--install-extension'/);
    assert.match(src, /'--extensions-dir', extensionsDir/);
    assert.match(src, /\.\.\.\(vsix \? \[\] : \['--disable-extensions'\]\)/);
  });

  it('passes the documented launch arguments and test environment', () => {
    for (const a of ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir=', '--extensions-dir=']) assert.ok(src.includes(a), a);
    assert.match(src, /extensionDevelopmentPath:\s*devPath/);
    assert.match(src, /const devPath = vsix && exe \? installVsix\([^)]*\) : root;/, 'the repo build is the extension under development unless an installed .vsix is requested');
    assert.match(src, /extensionTestsPath:\s*join\(root,\s*'out',\s*'integration',\s*'index\.js'\)/);
    assert.match(src, /extensionTestsEnv:\s*layout\.env/);
  });

  it('the layout env carries FILE_SHAKE_TEST=1 for every variant', () => {
    const root = join(REPO_ROOT, 'test', 'fixtures');
    for (const v of VARIANTS) {
      const layout = prepareLayout(v, root);
      try {
        assert.equal(layout.env['FILE_SHAKE_TEST'], v === 'real' ? '0' : '1', 'only the real-time variant runs without the test seam');
        assert.equal(layout.env['FS_TEST_VARIANT'], v);
      } finally {
        rmSync(layout.root, { recursive: true, force: true });
      }
    }
  });
});

describe('integration harness: temp dirs, fixtures, layouts', () => {
  it('repoRoot points at the repository (package.json is there)', () => {
    assert.ok(existsSync(join(repoRoot(), 'package.json')));
    assert.equal(repoRoot(), REPO_ROOT);
  });

  it('makeShortTempDir: short, unique, real path', () => {
    const a = makeShortTempDir();
    const b = makeShortTempDir();
    try {
      assert.notEqual(a, b);
      assert.ok(a.length < 40, `${a} is ${a.length} chars; the macOS socket path limit is ~104 for the whole <dir>/ud/<version>-main.sock path`);
      assert.ok(existsSync(a));
      assert.equal(lstatSync(a).isSymbolicLink(), false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('copyFixtureTree strips the .fixture suffix, keeps everything else, and recurses', () => {
    const src = mkdtempSync(join(tmpdir(), 'fs-harness-src-'));
    const dest = join(mkdtempSync(join(tmpdir(), 'fs-harness-dst-')), 'out');
    try {
      mkdirSync(join(src, 'deep', 'er'), { recursive: true });
      writeFileSync(join(src, 'a.ts.fixture'), 'A');
      writeFileSync(join(src, 'plain.txt'), 'P');
      writeFileSync(join(src, 'deep', 'er', 'b.py.fixture'), 'B');
      writeFileSync(join(src, 'weird.fixture.fixture'), 'W');
      copyFixtureTree(src, dest);
      assert.equal(readFileSync(join(dest, 'a.ts'), 'utf8'), 'A');
      assert.equal(readFileSync(join(dest, 'plain.txt'), 'utf8'), 'P');
      assert.equal(readFileSync(join(dest, 'deep', 'er', 'b.py'), 'utf8'), 'B');
      assert.equal(readFileSync(join(dest, 'weird.fixture'), 'utf8'), 'W', 'only one suffix is stripped');
      assert.deepEqual(readdirSync(dest).sort(), ['a.ts', 'deep', 'plain.txt', 'weird.fixture']);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(join(dest, '..'), { recursive: true, force: true });
    }
  });

  it('the workspace fixture copies into real, importable TypeScript files', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fs-harness-ws-')), 'ws');
    try {
      copyFixtureTree(fixturePath('workspace'), dest);
      assert.match(readFileSync(join(dest, 'a.ts'), 'utf8'), /from '\.\/b'/);
      assert.ok(existsSync(join(dest, 'src', 'util.ts')));
      assert.ok(existsSync(join(dest, 'node_modules', 'pkg', 'index.js')));
      assert.ok(!readdirSync(dest).some((n) => n.endsWith('.fixture')));
    } finally {
      rmSync(join(dest, '..'), { recursive: true, force: true });
    }
  });

  it('prepareLayout(single): opens a copy of the workspace fixture, with a seeded user settings file', () => {
    const layout = prepareLayout('single', fixturePath('.'));
    try {
      assert.equal(layout.openArg, layout.env['FS_TEST_WORKSPACE']);
      assert.ok(existsSync(join(layout.openArg ?? '', 'a.ts')));
      assert.ok(layout.root.length < 40);
      const settings = JSON.parse(readFileSync(join(layout.userDataDir, 'User', 'settings.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(settings, JSON.parse(JSON.stringify(TEST_USER_SETTINGS)));
      assert.equal(settings['files.autoSave'], 'off', 'autosave would make saves look like edits');
      assert.equal(settings['files.hotExit'], 'off');
      assert.ok(existsSync(join(layout.env['FS_TEST_OUTSIDE'] ?? '', 'o1.ts')), 'a directory outside the workspace exists for the "outside workspace" tests');
      assert.ok(!(layout.env['FS_TEST_OUTSIDE'] ?? '').startsWith(layout.openArg ?? '\u0000'), 'outside means outside');
      // the folder is the ONLY positional argument VS Code gets
      assert.ok(layout.userDataDir.startsWith(layout.root) && layout.extensionsDir.startsWith(layout.root));
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('prepareLayout(multi): a .code-workspace with two named folders', () => {
    const layout = prepareLayout('multi', fixturePath('.'));
    try {
      assert.ok(layout.openArg?.endsWith('.code-workspace'));
      const ws = JSON.parse(readFileSync(layout.openArg ?? '', 'utf8')) as { folders: Array<{ path: string; name: string }> };
      assert.deepEqual(ws.folders.map((f) => f.name), ['alpha', 'beta']);
      assert.ok(existsSync(join(layout.env['FS_TEST_ALPHA'] ?? '', 'shared.ts')));
      assert.ok(existsSync(join(layout.env['FS_TEST_BETA'] ?? '', 'shared.ts')));
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  });

  it('prepareLayout(none): no folder argument at all', () => {
    const layout = prepareLayout('none', fixturePath('.'));
    try {
      assert.equal(layout.openArg, undefined);
      assert.ok(existsSync(join(layout.env['FS_TEST_OUTSIDE'] ?? '', 'o1.ts')));
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  });
});

describe('integration harness: suite file selection', () => {
  it('variantOfSuiteFile', () => {
    assert.equal(variantOfSuiteFile('10-editing.single.test.js'), 'single');
    assert.equal(variantOfSuiteFile('50-multiroot.multi.test.js'), 'multi');
    assert.equal(variantOfSuiteFile('60-noworkspace.none.test.js'), 'none');
    assert.equal(variantOfSuiteFile('90-realtime.real.test.js'), 'real');
    assert.equal(variantOfSuiteFile('01-activation.test.js'), 'all');
    assert.equal(variantOfSuiteFile('40-view.test.js'), 'all');
  });

  it('selectSuiteFiles keeps only *.test.js of the right variant, sorted, and skips helpers', () => {
    const names = ['helpers.js', '60-noworkspace.none.test.js', '10-editing.single.test.js', '01-activation.test.js', '50-multiroot.multi.test.js', '40-view.test.js', '10-editing.single.test.js.map', 'README.md'];
    assert.deepEqual(selectSuiteFiles(names, 'single'), ['01-activation.test.js', '10-editing.single.test.js', '40-view.test.js']);
    assert.deepEqual(selectSuiteFiles(names, 'multi'), ['01-activation.test.js', '40-view.test.js', '50-multiroot.multi.test.js']);
    assert.deepEqual(selectSuiteFiles(names, 'none'), ['01-activation.test.js', '40-view.test.js', '60-noworkspace.none.test.js']);
    assert.deepEqual(selectSuiteFiles(names, 'bogus'), ['01-activation.test.js', '40-view.test.js']);
    const withReal = [...names, '90-realtime.real.test.js'];
    assert.deepEqual(selectSuiteFiles(withReal, 'real'), ['90-realtime.real.test.js'], 'the real-time variant has no test seam, so seam-based suites must not run in it');
    assert.ok(!selectSuiteFiles(withReal, 'single').includes('90-realtime.real.test.js'));
  });

  it('every suite source file has a recognised name, and each variant has at least one dedicated suite', () => {
    const dir = join(REPO_ROOT, 'test', 'integration', 'suite');
    const tests = readdirSync(dir).filter((n) => n.endsWith('.test.ts'));
    assert.ok(tests.length >= 6, tests.join(','));
    for (const v of VARIANTS) assert.ok(tests.some((n) => variantOfSuiteFile(n.replace(/\.ts$/, '.js')) === v), `no suite for variant ${v}`);
    assert.ok(tests.some((n) => variantOfSuiteFile(n.replace(/\.ts$/, '.js')) === 'all'));
  });

  it('suite files use mocha tdd (suite/test), never describe/it (the runner is configured with ui: "tdd")', () => {
    const dir = join(REPO_ROOT, 'test', 'integration', 'suite');
    for (const n of readdirSync(dir).filter((x) => x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, n), 'utf8');
      assert.match(src, /\bsuite\(/, n);
      assert.ok(!/\bdescribe\(|\bit\(/.test(src), `${n} uses bdd`);
    }
    assert.match(readRepoFile('test', 'integration', 'index.ts'), /ui:\s*'tdd'/);
  });

  it('no suite uses a fixed sleep for synchronisation (all waits go through waitUntil*)', () => {
    const dir = join(REPO_ROOT, 'test', 'integration', 'suite');
    for (const n of readdirSync(dir).filter((x) => x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, n), 'utf8');
      assert.ok(!/\bsetTimeout\(/.test(src), `${n} calls setTimeout directly`);
      assert.ok(!/await\s+delay\(/.test(src), `${n} sleeps with delay()`);
    }
  });
});
