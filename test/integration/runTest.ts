// Integration test launcher. Run with:  node --import tsx test/integration/runTest.ts
// (npm run test:integration builds first). Never downloads VS Code when FS_VSCODE_EXE is set.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { VARIANTS, prepareLayout, repoRoot, scrubEnv } from './harness';
import type { Variant } from './harness';

/**
 * FS_INSTALLED_VSIX=<file.vsix>: run the suite against the INSTALLED extension instead of the repo build. The .vsix is
 * installed with the VS Code CLI into the launch's isolated --extensions-dir, and a stub "extension under development" is
 * used only to host the test runner (the real File Shake is then loaded from the extensions dir, like for a user).
 */
function installVsix(exe: string, vsix: string, extensionsDir: string, userDataDir: string, root: string): string {
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  if (!cli) throw new Error('could not resolve the VS Code CLI from FS_VSCODE_EXE');
  const res = spawnSync(cli, [...cliArgs, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--install-extension', vsix], {
    encoding: 'utf8',
    env: process.env, // already scrubbed
    timeout: 120_000,
  });
  const out = `${res.stdout}${res.stderr}`;
  if (res.status !== 0 || !/successfully installed/i.test(out)) throw new Error(`installing ${vsix} failed (status ${String(res.status)}): ${out}`);
  console.log(`[runTest] installed ${vsix}: ${out.trim().split('\n').pop() ?? ''}`);
  const host = join(root, 'testhost');
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'fs-test-host', publisher: 'fs-test', version: '0.0.0', engines: { vscode: '^1.85.0' } }));
  return host;
}

async function main(): Promise<void> {
  // Read our own inputs BEFORE scrubbing: VSCODE_TEST_VERSION is itself a VSCODE_* variable.
  const exe = process.env['FS_VSCODE_EXE'];
  const vsix = process.env['FS_INSTALLED_VSIX'];
  if (vsix && !exe) throw new Error('FS_INSTALLED_VSIX needs FS_VSCODE_EXE (the CLI is resolved from the executable)');
  const version = process.env['VSCODE_TEST_VERSION'] ?? process.env['FS_VSCODE_VERSION'] ?? 'stable';
  const wanted = (process.env['FS_TEST_VARIANTS'] ?? VARIANTS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Variant => (VARIANTS as readonly string[]).includes(s));
  if (wanted.length === 0) throw new Error(`FS_TEST_VARIANTS selects no known variant (known: ${VARIANTS.join(', ')})`);

  // Environment trap (DESIGN 13): these sessions run inside a VS Code extension host.
  const removed = scrubEnv(process.env);
  if (removed.length > 0) console.log(`[runTest] scrubbed from the environment: ${removed.join(', ')}`);

  const root = repoRoot();
  const fixtures = join(root, 'test', 'fixtures');
  const failures: string[] = [];

  for (const variant of wanted) {
    const layout = prepareLayout(variant, fixtures);
    console.log(`[runTest] === variant: ${variant} (temp ${layout.root}) ===`);
    const launchArgs = [
      ...(layout.openArg ? [layout.openArg] : []),
      // with an installed copy the extensions dir must stay enabled; built-ins are unaffected either way
      ...(vsix ? [] : ['--disable-extensions']),
      '--disable-workspace-trust',
      `--user-data-dir=${layout.userDataDir}`,
      `--extensions-dir=${layout.extensionsDir}`,
    ];
    try {
      const devPath = vsix && exe ? installVsix(exe, vsix, layout.extensionsDir, layout.userDataDir, layout.root) : root;
      await runTests({
        ...(exe ? { vscodeExecutablePath: exe } : { version }),
        extensionDevelopmentPath: devPath,
        extensionTestsPath: join(root, 'out', 'integration', 'index.js'),
        extensionTestsEnv: layout.env,
        launchArgs,
      });
      console.log(`[runTest] variant ${variant}: PASSED`);
    } catch (e) {
      failures.push(variant);
      console.error(`[runTest] variant ${variant}: FAILED (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      if (process.env['FS_KEEP_TMP'] !== '1') {
        try {
          rmSync(layout.root, { recursive: true, force: true });
        } catch {
          /* best effort: temp dir cleanup must not mask the test result */
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`[runTest] failed variants: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`[runTest] all variants passed: ${wanted.join(', ')}`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
