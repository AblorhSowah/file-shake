// Pure Node helpers for the integration harness. No VS Code, no network. Unit-tested in
// test/unit/harness.test.ts so the environment traps from DESIGN 13 cannot silently regress.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * single/multi/none run with the fake clock + scheduler test seam (FILE_SHAKE_TEST=1). `real` is a single-root launch WITHOUT the
 * seam: the extension runs on the system clock and real timers, exactly as shipped.
 */
export type Variant = 'single' | 'multi' | 'none' | 'real';
export const VARIANTS: readonly Variant[] = ['single', 'multi', 'none', 'real'];

/** Repository root (this file lives in test/integration). */
export function repoRoot(): string {
  return typeof __dirname === 'string' ? resolve(__dirname, '..', '..') : process.cwd();
}

/**
 * The shell these agents run in is itself a VS Code extension host, so it carries ELECTRON_RUN_AS_NODE and
 * VSCODE_* variables. Inherited by the launched Electron they turn it into a plain Node process
 * ("Cannot find module '<workspace>'"). Removes them in place; returns the removed keys.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed.sort();
}

/** Short, real (symlink-resolved) temp directory: macOS caps unix-socket paths at ~104 bytes. */
export function makeShortTempDir(prefix = 'fs-'): string {
  const base = process.env['FS_TEST_TMP'] ?? (process.platform === 'win32' ? tmpdir() : '/tmp');
  return realpathSync(mkdtempSync(join(base, prefix)));
}

/** Copies a directory tree; a `.fixture` suffix is stripped from file names (keeps fixtures out of tsc / eslint / vsce). */
export function copyFixtureTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (statSync(from).isDirectory()) {
      copyFixtureTree(from, join(dest, name));
    } else {
      copyFileSync(from, join(dest, name.endsWith('.fixture') ? name.slice(0, -'.fixture'.length) : name));
    }
  }
}

/**
 * Which launch variant a suite file belongs to: `x.single.test.js` -> single, `x.multi.test.js` -> multi,
 * `x.none.test.js` -> none, anything else runs in every variant.
 */
export function variantOfSuiteFile(name: string): Variant | 'all' {
  const m = /\.(single|multi|none|real)\.test\.[cm]?[jt]s$/.exec(name);
  return m ? (m[1] as Variant) : 'all';
}

export function selectSuiteFiles(names: readonly string[], variant: string): string[] {
  return names
    .filter((n) => /\.test\.[cm]?js$/.test(n))
    .filter((n) => {
      const v = variantOfSuiteFile(n);
      // untagged suites need the test seam, so they never run in the real-time variant
      if (variant === 'real') return v === 'real';
      return v === 'all' || v === variant;
    })
    .sort();
}

/** VS Code user settings that keep the test instance quiet and deterministic. */
export const TEST_USER_SETTINGS: Readonly<Record<string, unknown>> = {
  'files.autoSave': 'off',
  'editor.formatOnSave': false,
  'editor.formatOnType': false,
  'editor.formatOnPaste': false,
  'editor.codeActionsOnSave': {},
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'window.restoreWindows': 'none',
  'window.newWindowDimensions': 'default',
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'files.hotExit': 'off',
  'files.watcherExclude': {},
  // renaming a .ts file through a WorkspaceEdit would otherwise open a modal "Update imports?" dialog, which the test host refuses
  'typescript.updateImportsOnFileMove.enabled': 'never',
  'javascript.updateImportsOnFileMove.enabled': 'never',
};

export interface Layout {
  variant: Variant;
  /** Temp root holding everything for this launch. */
  root: string;
  /** Argument for the VS Code CLI (folder or .code-workspace); undefined = no folder open. */
  openArg: string | undefined;
  userDataDir: string;
  extensionsDir: string;
  env: Record<string, string>;
}

/** Builds the on-disk layout for one launch variant from test/fixtures. */
export function prepareLayout(variant: Variant, fixturesDir: string): Layout {
  const root = makeShortTempDir();
  const userDataDir = join(root, 'ud');
  const extensionsDir = join(root, 'ext');
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify(TEST_USER_SETTINGS, null, 2));

  // A neighbour directory OUTSIDE every workspace folder, used by the "file outside the workspace" tests.
  const outside = join(root, 'outside');
  copyFixtureTree(join(fixturesDir, 'outside'), outside);

  const env: Record<string, string> = { FILE_SHAKE_TEST: variant === 'real' ? '0' : '1', FS_TEST_VARIANT: variant, FS_TEST_ROOT: root, FS_TEST_OUTSIDE: outside };
  // optional: run a subset of tests (mocha --grep) while debugging
  const grep = process.env['FS_TEST_GREP'];
  if (grep) env['FS_TEST_GREP'] = grep;
  let openArg: string | undefined;
  if (variant === 'single' || variant === 'real') {
    const ws = join(root, 'ws');
    copyFixtureTree(join(fixturesDir, 'workspace'), ws);
    openArg = ws;
    env['FS_TEST_WORKSPACE'] = ws;
    // A symlinked file that exists BEFORE VS Code starts (so it produces no watcher event): link.ts -> b.ts.
    try {
      symlinkSync(join(ws, 'b.ts'), join(ws, 'link.ts'));
      env['FS_TEST_SYMLINK'] = '1';
    } catch {
      /* symlinks may be unavailable (Windows without privileges): the symlink test skips itself */
    }
  } else if (variant === 'multi') {
    const base = join(root, 'multi');
    copyFixtureTree(join(fixturesDir, 'multiroot'), base);
    const file = join(root, 'multi.code-workspace');
    writeFileSync(file, JSON.stringify({ folders: [{ path: 'multi/alpha', name: 'alpha' }, { path: 'multi/beta', name: 'beta' }], settings: {} }, null, 2));
    openArg = file;
    env['FS_TEST_ALPHA'] = join(base, 'alpha');
    env['FS_TEST_BETA'] = join(base, 'beta');
  }
  return { variant, root, openArg, userDataDir, extensionsDir, env };
}
