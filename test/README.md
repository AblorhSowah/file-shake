# File Shake tests

Everything under `test/` is owned by the Tester. Product code (`src/`, `media/`, `package.json`, `esbuild.mjs`) is
never edited to make a test pass; defects are filed in `docs/QA_REPORT.md`.

The suite is test-first against `docs/DESIGN.md` (signatures, the section 6 math tables, the section 11 DOM
contract, the section 12 edge-case table, the section 14 test mapping). When the design is ambiguous the chosen
reading is listed under "Assumptions" in `docs/QA_REPORT.md`.

## Commands

All commands run from the repository root. Only the Builder runs `npm install`.

| What | Command |
|---|---|
| Unit + webview (fast, deterministic, no VS Code) | `npm run test:unit` |
| One file | `node --import tsx --test test/unit/intensity.test.ts` |
| One directory | `node --import tsx --test "test/webview/**/*.test.ts"` |
| Type-check the tests (and everything they import) | `npx tsc -p test/tsconfig.json --noEmit` |
| Lint the tests | `npx eslint test` |
| Integration, all three launch variants | `FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:integration` |
| Integration, selected variants | `FS_TEST_VARIANTS=single,multi FS_VSCODE_EXE=... npm run test:integration` |
| Everything | `npm test` |

`npm run test:integration` runs `npm run build && npm run build:test` first, then `node --import tsx test/integration/runTest.ts`.

### Integration environment variables

| Variable | Meaning |
|---|---|
| `FS_VSCODE_EXE` | Path of an installed VS Code executable. **Set it**: without it `@vscode/test-electron` downloads VS Code (hundreds of MB; do not do this on a slow link). It is deliberately not named `VSCODE_*` because that prefix is scrubbed (see below). |
| `FS_TEST_VARIANTS` | Comma list out of `single`, `multi`, `none` (default: all three, one VS Code launch each). |
| `VSCODE_TEST_VERSION` / `FS_VSCODE_VERSION` | Version to download when `FS_VSCODE_EXE` is unset (default `stable`). |
| `FS_INSTALLED_VSIX=<file.vsix>` | Run the suite against the **installed** extension: the `.vsix` is installed with the VS Code CLI into the launch's isolated extensions dir and a stub extension hosts the test runner. Needs `FS_VSCODE_EXE`. |
| `FS_TEST_GREP=<regex>` | Run only integration tests whose title matches (mocha `--grep`). |
| `FS_KEEP_TMP=1` | Keep the temp directory of each launch (workspace copy, user-data dir) for post-mortems. |
| `FS_TEST_TMP` | Parent directory for the temp dirs (default `/tmp`; keep it short, macOS limits unix socket paths to about 104 bytes). |

**Environment trap (DESIGN 13).** The agent shells run inside a VS Code extension host, so they carry
`ELECTRON_RUN_AS_NODE=1` and `VSCODE_*` variables. Inherited by the launched Electron they make it behave like plain
Node (`Cannot find module '<workspace>'`). `runTest.ts` therefore reads its own inputs first and then deletes
`ELECTRON_RUN_AS_NODE` and every `VSCODE_*` key from `process.env` (`scrubEnv`, unit-tested in `test/unit/harness.test.ts`).

## Layout

```
test/
  tsconfig.json                 DESIGN 3.1 + DOM.Iterable, fixtures excluded
  unit/                         node:test + node:assert/strict + tsx (core logic, manifest, static policy)
  webview/                      jsdom tests of src/webview (DOM contract, motion, security, CSS)
  integration/
    runTest.ts                  launcher (tsx), one VS Code launch per variant
    harness.ts                  pure Node helpers (env scrub, temp dirs, layouts); unit-tested
    index.ts                    mocha runner loaded inside VS Code (bundled by esbuild --tests)
    suite/*.test.ts             mocha `tdd` suites; `.single.` / `.multi.` / `.none.` in the file name pins a suite
                                to one launch variant, untagged suites run in every variant
  support/                      shared helpers (in-memory ProbeFs, jsdom harness, builders, static scanners)
  fixtures/
    langs/*.fixture             one positive+negative fixture per language (read by parsers.test.ts)
    workspace/  multiroot/  outside/   trees copied into a temp dir for each launch
```

Fixture files carry a `.fixture` suffix, which `copyFixtureTree` strips on copy. That keeps deliberately odd sources
out of `tsc`, `eslint` and the `.vsix`.

## Determinism rules

* No real clocks: `ManualClock` / `ManualScheduler` everywhere. In VS Code the extension runs on its own
  `ManualClock` (`FILE_SHAKE_TEST=1`) and the tests move it with `api.testing.advance(ms)`; `advance(0)` is a pure refresh.
* No sleeps for synchronisation. Real asynchrony (file watcher latency, reference analysis, webview start-up) is awaited by
  re-reading state (`waitUntil` in `suite/helpers.ts`, bounded by a timeout) or by `api.whenReferencesIdle()`.
* No network. The only download path is `@vscode/test-electron` when `FS_VSCODE_EXE` is not set.
* The pathological-input performance test runs in a child process with a hard timeout, so a catastrophic regex fails the
  test instead of hanging the run.

## What each test file covers

| File | Covers (DESIGN section) |
|---|---|
| `unit/intensity.test.ts` | 6: every row of every worked-example table, boundaries (0, 1, huge, NaN, negative, Infinity) |
| `unit/pathUtils.test.ts` | 7.1, 12 (Windows, UNC, drive letter, case-insensitive FS note, nested/multi root display paths) |
| `unit/clock.test.ts` | 7.1 `ManualClock`, `ManualScheduler`, system clock, `EventLog` ring buffer |
| `unit/config.test.ts` | 7.4 defaults, ranges, fuzz of `sanitizeConfig`, `toTrackerOptions` |
| `unit/activityTracker.test.ts` | 7.2 window, decay, idle boundary, retain, dedupe, eviction, rename/forgetUnder, clock regression, event cap |
| `unit/sourceClassifier.test.ts` | 7.3 all six rows, precedence (exhaustive 144 combinations), watcher rule, `BurstGuard` |
| `unit/glob.test.ts` | 7.3 exclude matcher and `relativeForMatch` |
| `unit/scan.test.ts` | 8.1 `scanCode` for every language family, shape invariants and fuzz |
| `unit/parsers.test.ts` | 8.4 one positive+negative fixture per language, `detectLanguage`, limits |
| `unit/usage.test.ts` | 8.2 `countUsages`, including the documented non-modelled behaviours |
| `unit/projectInfo.test.ts` | 8.5 tsconfig / jsconfig / go.mod / composer.json discovery |
| `unit/resolver.test.ts` | 8.5 per-language resolution incl. tsconfig `paths`/`extends`, `__init__.py`, SCSS partials, Go module, Java static/nested, probe budget and memo |
| `unit/analyze.test.ts` | 8.3 counting, the four worked counting examples, filtering, truncation, skipped files, timeouts |
| `unit/viewModel.test.ts`, `tree.test.ts`, `decorations.test.ts`, `statusText.test.ts` | 7.5 |
| `unit/protocol.test.ts`, `webviewHtml.test.ts` | 7.6 (malformed-message fuzz, CSP) |
| `unit/performance.test.ts` | 8.7 and 12 (5,000-line file, 500 KB pathological inputs, 200 rapid edits) |
| `unit/staticChecks.test.ts` | policy: core purity, webview bundle closure, no `any`, no HTML sinks, no sync fs, timers only via `Scheduler` |
| `unit/manifest.test.ts` | 13: manifest, pinned toolchain, settings vs `core/config`, README honesty, icon, licence |
| `unit/harness.test.ts` | the integration harness itself (env scrub, layouts, suite selection) |
| `webview/render.test.ts`, `motion.test.ts`, `interaction.test.ts`, `security.test.ts`, `lifecycle.test.ts`, `css.test.ts` | 11, 12 (W rows) |
| `unit/vsix.test.ts` | package audit of `file-shake-0.1.0.vsix` (run `npm run package` first): exact 10-file list, size, no maps, manifest, icon header, `require()` set, stub-`vscode` load of the bundle |
| `unit/analyzeProperties.test.ts` | invariants of `analyzeReferences` over random trees and random import statements in 11 language families |
| `integration/suite/*.test.ts` | 14 integration list, 12 (I rows) in a real VS Code. `70-scenarios` real-world scenarios (external processes, fan-out, rename/delete, floods, enable toggling, atomic replace), `75-adversarial` defect reproductions (`[QA-nnn]` tests FAIL until the defect is fixed), `76-folders.multi` folders added/removed at runtime, `80-performance` per-edit cost on the real adapters |
