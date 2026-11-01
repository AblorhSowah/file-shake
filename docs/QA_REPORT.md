# QA Report - File Shake 0.1.0 (Tester)

Status: **Phase 2 complete** (adversarial reads, mutation sampling, package audit, `.vsix` install check, real-time variant).
Phase 2 found five defects (QA-002..QA-006). QA-003..QA-006 are fixed and verified in real VS Code; QA-002 is fixed by reasoning only (see 3).
The Tester (an earlier session's agent) was cut off by a usage limit before it could write this up; the final verification and this
section were completed in a later session. Phase 1 text below is unchanged where it is still true.

Everything below was actually run on this machine (macOS 24.2, Node v24.20.0, VS Code 1.129.1 at
`/Applications/Visual Studio Code.app`). Nothing is reported that was not executed.

## 1. Summary

| Area | Result |
|---|---|
| Unit + webview (`npm run test:unit`) | **1284 / 1284 pass**, 0 fail, 0 skipped (about 10 s) |
| `npm run lint` (`eslint .` + all three `tsc` projects) | exit 0 |
| Integration, dev build, real VS Code 1.129.1, all four variants | single **86 pass**, multi **25**, none **24**, real **6**; 0 fail; 1 pending (QA-002, see 3). Two consecutive full runs. |
| Integration against the installed `.vsix` (`FS_INSTALLED_VSIX`) | same four variants, **all pass**; two consecutive full runs on the final package |
| Package audit | `file-shake-0.1.0.vsix`: 10 files, 52 KB; no `.map`, `src`, `test`, `node_modules`, `.ts` |
| Standalone CLI install (isolated user-data and extensions dirs) | `Extension 'file-shake-0.1.0.vsix' was successfully installed.`; `--list-extensions --show-versions` prints `file-shake.file-shake@0.1.0` |
| Mutation sampling (scratch copies, never `src/`) | unit level: 76 mutants, 75 killed (72 at first, 3 more after the tests were strengthened), 1 survivor that is equivalent (`>=` vs `>` at exactly `idleTimeoutMs`, where the intensity formula is already 0). Integration level: partial, see 6. |

Open bugs: **none known**. Unverified: QA-002, Windows/Linux, VS Code 1.85, visible rendering in light/dark/HC themes (see 5).

## 2. Commands run

```
npx tsc -p test/tsconfig.json --noEmit                  # exit 0
npx eslint test                                         # exit 0 (clean)
npm run lint                                            # exit 0
npm run test:unit                                       # tests 1257, pass 1257, fail 0
npm run build && npm run build:test
FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
  node --import tsx test/integration/runTest.ts         # variants single, multi, none: all PASSED
FS_TEST_VARIANTS=single FS_TEST_GREP="undo is classified|saving is not activity" ...   # targeted re-run while debugging
```

The integration run printed `[runTest] scrubbed from the environment: ELECTRON_RUN_AS_NODE, VSCODE_CODE_CACHE_PATH,
VSCODE_CRASH_REPORTER_PROCESS_TYPE, VSCODE_CWD, VSCODE_ESM_ENTRYPOINT, VSCODE_HANDLES_UNCAUGHT_ERRORS, VSCODE_IPC_HOOK,
VSCODE_L10N_BUNDLE_LOCATION, VSCODE_NLS_CONFIG, VSCODE_PID`: the environment trap from DESIGN 13 is real in this shell and
the harness handles it. VS Code was never downloaded (`FS_VSCODE_EXE`). Each launch used an isolated `--user-data-dir` /
`--extensions-dir` under `/tmp/fs-XXXXXX`, so the user's own VS Code was untouched.

## 3. Bugs

| ID | Severity | Status | Failing test(s) / repro | Expected | Actual |
|---|---|---|---|---|---|
| QA-001 | low | **fixed** (verified) | `test/unit/resolver.test.ts` > "root-relative specifiers try every workspace root" and `test/unit/resolver.test.ts` > "a leading slash is relative to the workspace root(s)". Repro: `analyzeReferences` for `/w1/a.ts` with roots `['/w1','/w2']` and `import x from '/shared/only-in-second'` where only `/w2/shared/only-in-second.ts` exists. | DESIGN 8.5: `/x` is resolved "relative to each workspace root" (TS/JS) / "workspace root(s)" (HTML, Markdown). | At first run only the root containing the importing file was searched, so the target in the other root was reported unresolved (2 failures). The Builder then made it try every root, containing root(s) first, and recorded it in DESIGN Deviations. Re-run after the change: both tests pass. |

| QA-002 | medium | **fixed, not demonstrated** | `75-adversarial.single` > "[QA-002] closing a document without saving and re-opening it must not reuse ..." | A document closed unsaved and re-opened is a new object whose `version` restarts at 1; the reference cache must not reuse the discarded buffer's result when the new buffer reaches the same version number. | Cache key was `doc:<version>` only. Now `doc:<identity>:<version>` (`referenceService.ts`). The reproducer needs VS Code to dispose the text model after the editor closes; on 1.129.1 the model outlives the editor, so the test skips itself. |
| QA-003 | medium | **fixed** (verified) | `75-adversarial.single` > "[QA-003] ..." | With `showWhenIdle` on, renaming an unrelated file must not drop the references shown for idle files. | After a rename only active sources were re-analysed, so idle rows lost their yellow references. Now every source on screen is re-requested. |
| QA-004 | low | **fixed** (verified) | "[QA-004] ..." | Turning `showWhenIdle` off while a file is idle schedules its removal. | No timer was pending, so the idle row stayed until something else happened. `applyConfig` now restarts the tick. |
| QA-005 | medium | **fixed** (verified) | "[QA-005] ..." | Renaming a file you are typing in keeps it `you`. | The watcher's echo of the rename was classified `external` and flipped the source. The echo is now `self-save` when tracked state moved. |
| QA-006 | medium | **fixed** (verified) | "[QA-006] ..." | A checkout rewriting 45 files that are open in editors is suppressed by `BurstGuard` like any flood. | Reloads of open documents bypassed `BurstGuard`; 40 of 45 files were shown. `external` document events now pass it. |

No other test failed against the Builder's implementation once the test-side mistakes below were corrected.

Test-side corrections made during Phase 1 (not product bugs, listed so the history is honest):
* `integration`: "undo is classified as you" and "saving is not activity" first failed (`6 !== 0`, `27 !== 29`) because the event log is
  a shared ring buffer that still held `reload-from-disk` entries from earlier tests' reverts. Both tests now look only at entries
  stamped after a fake-clock mark; both pass, in isolation and in the full run.
* `glob`: a lone `!` entry matches everything (picomatch negation); removed from the "weird glob" list (that is picomatch semantics, not a defect).
* `webview`: I had asserted that `ul.fs-tree` is absent in the empty state and that Space on a folder toggle flips it; the contract
  says neither, so the assertions were relaxed / removed (Space on a `<button>` is native click behaviour).

Test-side corrections made in Phase 2 (not product bugs):
* `76-folders.multi` "a folder added at runtime is watched ...": the test wrote one file right after the workspace-folder change event. VS Code starts
  watching an added folder asynchronously, so that single write is sometimes never reported. Measured on a pristine copy of the unmodified code: 5 failures
  in 8 runs; the extension's event log held no entry at all for the new folder, i.e. VS Code never delivered the event. The test now rewrites the file every
  500 ms until it is seen; 10 / 10 runs pass, and the watcher always saw the file within one rewrite.
* `75-adversarial.single` QA-006: the wait for "reload events classified" now also accepts reason `burst`, which is the correct outcome once the flood is suppressed.

Observation, not a bug: the test host prints `rejected promise not handled within 1 second: cannot open file .../scratch-rename-4/after.ts`
after the rename test. File Shake never calls `openTextDocument`; this is a built-in extension (TypeScript "update imports on file
move") opening the renamed file after the test removed it. Harmless noise.

## 4. Test inventory

Counts are test cases as reported by `node --test` (unit, webview) or defined `test(...)` blocks (integration).

### Unit (`test/unit`, 1132 cases)

| File | Cases | What it asserts |
|---|---|---|
| `intensity.test.ts` | 91 | every row of every DESIGN 6 table, boundaries (0, 1, huge, NaN, negative, +-Infinity), monotonicity |
| `pathUtils.test.ts` | 46 | normalise/dirname/basename/extname/join/isUnder/relativeTo/hasSegment/toDisplayPath; Windows, UNC, drive letters, nested and multi roots |
| `clock.test.ts` | 17 | `ManualClock`, `ManualScheduler` ordering/cancel/nesting, system clock, `EventLog` ring buffer |
| `config.test.ts` | 52 | defaults, clamps, rounding, booleans, globs, colours, 500 fuzz combinations, `toTrackerOptions` |
| `constants.test.ts` | 29 | DESIGN 5 values literally (other tests compare against `K.*`, so they would not notice a changed constant) |
| `activityTracker.test.ts` | 55 | window/decay tables through the tracker, idle boundary at exactly `idleTimeoutMs`, retain, dedupe, eviction, rename/forgetUnder, clock regression, 512-event cap |
| `sourceClassifier.test.ts` | 25 | all six rows, precedence (all 144 combinations), watcher rule, `BurstGuard` incl. "100 files in 1 s -> exactly 30" |
| `glob.test.ts` | 52 | default globs on 38 paths, invalid entries, nocase, `relativeForMatch` |
| `scan.test.ts` | 50 | `scanCode` per family (comments, strings, templates, regex vs division, Rust nesting/raw/lifetimes, Go raw, Java text blocks, Python prefixes/triple quotes, Ruby `=begin`, PHP blocks, CSS vs SCSS `//`, HTML, Markdown) + shape fuzz |
| `parsers.test.ts` | 201 | one positive+negative fixture per language (16), `detectLanguage`, MAX_STATEMENTS, specifier limits, CRLF, token-soup fuzz |
| `usage.test.ts` | 17 | `countUsages` boundaries, dotted locals, excluded lines, documented non-modelled behaviours |
| `projectInfo.test.ts` | 10 | tsconfig/jsconfig/go.mod/composer.json discovery, malformed config, fs failures |
| `resolver.test.ts` | 159 | per-language resolution (TS/JS incl. paths/extends/baseUrl and the full extension order, Python, Go, Java/Kotlin, C/C++, Rust, Ruby, PHP, CSS/SCSS/Less, HTML, Markdown), probe budget and memo |
| `analyze.test.ts` | 39 | the four DESIGN 14 counting examples, filtering (self, node_modules, excluded, missing), 30-target truncation, skipped files (too-large, binary, excluded, unsupported), deadline, probe budget |
| `viewModel.test.ts` | 24 | rows, green wins, sources limit, idle/showWhenIdle, summed counts, ordering, trimming to `maxFiles` |
| `tree.test.ts` | 18 | compaction, ids, ordering (never by intensity), aggregates, multi-root, hostile names |
| `decorations.test.ts` | 16 | badges (`9+`, <= 2 UTF-16 units over 2,000 inputs), colours, propagate, idle rule, `changedKeys`, no per-keystroke churn |
| `statusText.test.ts` | 11 | all `buildStatus` rules and tooltip format |
| `protocol.test.ts` | 79 | 59 individually named malformed-field mutations (25 snapshot-level, 34 row-level), 500/501 rows, cyclic/deep/throwing-getter/proxy input, fuzz, webview-to-host messages, truncation |
| `webviewHtml.test.ts` | 13 | exact CSP, nonce, single script, escaping, `makeNonce` |
| `performance.test.ts` | 11 | 5,000-line file <= 400 ms, 32 pathological 500 KB patterns x 16 languages in a child process with a hard timeout (each <= 1000 ms), 200 rapid edits <= 20 ms, 10k events, model refresh, 500-row validation |
| `staticChecks.test.ts` | 22 | `src/core` purity, webview bundle closure, no `any`, no HTML sinks, no inline style/handlers, no sync fs, no direct timers outside `core/clock`, commands match the manifest |
| `manifest.test.ts` | 76 | package.json fields, exact pins, scripts, colours, 14 settings vs `core/config`, README honesty (DESIGN 2/9), LICENSE, CHANGELOG, `.vscodeignore`, 128x128 RGBA icon |
| `harness.test.ts` | 19 | env scrub trap, temp dirs, fixture copy, layouts per variant, suite selection, no sleeps in suites |

### Webview (`test/webview`, 125 cases, jsdom)

| File | Cases | What it asserts |
|---|---|---|
| `render.test.ts` | 35 | the DOM contract, exact CSS variable strings (`2.25px`, `110ms`, `0.7deg`, `0.5`), colour overrides, folders/compaction/ordering, in-place updates, `seq` ordering |
| `motion.test.ts` | 10 | `.is-shaking` iff motion on and active and intensity > 0; reduced motion (initial and live) and `animate:false` keep colour/badge/meter |
| `interaction.test.ts` | 23 | open on click/Enter/Space, collapse + persistence + auto-expand on new file, `preventDefault` on Enter, leaving/revive timers (`LEAVE_MS`) |
| `security.test.ts` | 24 | 14 hostile names as text only, selector-breaking ids, runtime guard on `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`setAttribute('style')`, 20 malformed messages |
| `lifecycle.test.ts` | 9 | dispose twice, post-dispose messages and clicks, subscription release, two independent views |
| `css.test.ts` | 15 | `media/webview.css` contract (keyframes, reduced-motion, HC, colour chains, no remote URLs) + jsdom cascade: collapsed children really hidden |
| `bundle.test.ts` | 9 | the **shipped** `dist/webview.js` executed in a page from `buildWebviewHtml` with a stubbed `acquireVsCodeApi` (covers `main.ts`) |

### Integration (`test/integration`, 78 cases, real VS Code, mocha `tdd`)

| File | Variant | Cases | What it asserts |
|---|---|---|---|
| `01-activation.test.ts` | all | 12 | activation, exports, commands incl. `fileShake.view.focus`, empty model, setting defaults served by VS Code, opening files is not activity, view resolves + posts `ready`, toggle both ways, clear, debug info* |
| `10-editing.single.test.ts` | single | 23 | typing -> `edited/you` row, `●` + ThemeColor + tooltip, status text, `a.ts` -> `b.ts` (count 4) / `c.ts` (1) yellow with `4`/`1` badges, green wins, Python and SCSS targets, intensity 0.2835 / 0.5905 / 0.9639 on the fake clock, idle at exactly 2500 ms and removal at 6500 ms, unfocused window -> `external`, `WorkspaceEdit` -> `external`, undo -> `you`, save is not activity, untitled/excluded ignored, clear, symlink target, file outside the workspace, 200 rapid edits, odd file names |
| `20-watcher.single.test.ts` | single | 12 | disk write/create -> `external` row + `◆` + 0.8647, references from an externally written file, delete, folder delete, rename, 60-file burst suppressed, directory create ignored, excluded paths, > 512 KB file and NUL file tracked but not scanned, reload de-duplication |
| `30-settings.single.test.ts` | single | 13 | live `enableAnimation`, colours (valid/invalid), `enable`, `idleTimeoutMs` (and clamp), `sensitivity`, `showWhenIdle`, `decorateFolders`, `detectExternalEdits`, `excludeGlobs`, `maxFiles`, junk values, concurrent updates |
| `40-view.test.ts` | all | 4 | `ready` handshake, snapshots while visible, nothing sent while hidden and resend on show, focus while disabled |
| `50-multiroot.multi.test.ts` | multi | 7 | two folders, same file name in both roots stays distinct, root-name prefixes, cross-root reference, one watcher per folder, outside-workspace file |
| `60-noworkspace.none.test.ts` | none | 7 | no folder: tracking, `(outside workspace)` grouping, neighbour references, exclude globs on absolute paths, commands, idle clean-up |
| `70-scenarios.single.test.ts` | single | 8 | real-world scenarios: external edit of an open clean file and of an open dirty file, edit -> idle -> removed lifecycle, a file importing six others (counts 1..6), rename + delete while the importer is edited, 50 files created in one second, toggling `enable` with the view open, atomic replace (temp file renamed over an open file) |
| `75-adversarial.single.test.ts` | single | 11 | probes written to break the adapters: QA-002..QA-006, references following the text of an open document, folder rename re-keying, format-on-save edits, autosave echo |
| `76-folders.multi.test.ts` | multi | 1 | a workspace folder added and removed at runtime: watched, displayed under its own name, cross-root imports resolve |
| `80-performance.single.test.ts` | single | 3 | 200 rapid edits (overhead per edit), model refresh with 40 files x 30 references <= 5 ms, typing in a 400 KB file |
| `90-realtime.real.test.ts` | real | 6 | launch variant without the test seam: the production configuration, real window focus, first keystroke never a reload, real tick chain (active -> idle -> removed), external write, burst of 150 keystrokes, real rename/delete |

Totals after Phase 2: unit and webview 1284 (the table above lists the Phase 1 counts of 1132 + 125), integration 142 defined across the four variants (141 pass, 1 skipped).

## 5. Not executed / not covered (what stays unverified)

* **Visible rendering inside a real VS Code window has not been looked at.** What is proven: DOM, classes, CSS custom properties and CSS text (jsdom),
  the shipped bundle running under a stub (jsdom), the Builder's headless-Chromium run of the webview on a mock page (colours, `transform` changing
  frame to frame, reduced motion, light theme), and in real VS Code that the view resolves, posts `ready` and receives snapshots, that the explorer
  badge and colours are set, and that the status bar text is right. What no run covered: the sidebar webview actually shaking on screen in VS Code, dark and
  high-contrast themes, and whether the CSP lets the nonce'd script run in a real webview beyond the observed `ready` handshake.
* **QA-002** is fixed by reasoning; its reproducer skips itself on VS Code 1.129.1 because the text model outlives the editor (1 pending test).
* **Skipped by design:** "showDebugInfo writes JSON" (the Output channel text cannot be read through the API; the command runs without error).
  "Deactivate / dispose twice" (DESIGN 12, row I) cannot be driven through the public API; it is covered statically (`staticChecks.test.ts`), not dynamically.
  The former "zero timers when idle" skip is gone: `FileShakeApi.testing.pendingTimers()` exists and the test runs.
* **Only VS Code 1.129.1 on macOS was run.** The engine floor (1.85.0) was not launched (`VSCODE_TEST_VERSION=1.85.0` re-runs the suite on it, about a 124 MB download).
  Windows and Linux were not run; Windows behaviour is covered at the key/path level in unit tests only.
* **Not published.** `package.json` has placeholder `publisher` (`file-shake`) and `repository.url` (`.../OWNER/file-shake.git`); see `docs/BUILD_STATUS.md` "Release checklist".
* Writes to a workspace folder in the first few hundred milliseconds after it is added can be missed. That is VS Code's asynchronous watcher start, not File Shake (see 3).

## 6. Mutation sampling (preliminary Phase 2 item, done in a scratch copy under the session scratchpad)

23 single-line mutants, each run against the most relevant test files; all killed:
idle boundary `<` to `<=`; retain boundary; `FLOOR` removed; `MIN_SPAN_MS` removed; burst `>` to `>=`; glob `dot:true` to `false`;
node_modules filter removed; badge `9+` threshold; webview ignores `animate`; `MAX_REFS_PER_SOURCE` 30 to 31; `REF_SATURATION` 32 to 31;
Python relative level off by one; referenced sort order; `is-idle` class removed; config max clamp removed; protocol colour check removed;
`EXTERNAL_EVENT_WEIGHT` 6 to 5; external dedupe removed; Enter-on-toggle `preventDefault` removed; folder auto-expand removed;
Rust nested comments off; `name` via `innerHTML`; `.tsx` probed before `.ts` (TS extension order).
Two survived at first (`MAX_REFS_PER_SOURCE`, TS extension order) because the tests compared against `K.*` / did not probe `.ts` vs `.tsx`;
`constants.test.ts` and the full extension-order tests were added and then killed them.

Phase 2 extended this to **76 unit-level mutants**: 72 killed in the first pass, the 4 survivors were re-checked after strengthening the tests and 3 of them are now killed. The one survivor, idle boundary `>=` to `>` in
`core/intensity.ts`, is an equivalent mutant: at exactly `idleTimeoutMs` the formula `1 - since / idleTimeoutMs` already returns 0. Mutants that survived the first pass and were then killed
by new tests: burst guard counting repeated keys, `lastEditAt` moving backwards, target cap off by one.

**Integration-level** mutation (about 35 mutants of `src/vscode/**`, run in scratch copies) was interrupted by the usage limit and is not conclusive: several survivors are
not observable through the public API (status bar visibility, dispose paths, which row a webview click opens), and the scratch copies did not carry the nested `node_modules` fixtures,
so every run had two baseline failures. Re-checked afterwards with the fixtures restored (clean baseline: 85 pass, 0 fail):
* removing the dirty-flag settling entirely (the real bug found in the Builder's smoke test: the first keystroke classified `external`): **killed by 17 tests**;
* shortening the settle delay from 150 ms to 0 (`DIRTY_SETTLE_MS`): **survives** in `single` and `real`; on VS Code 1.129.1 the dirty-state event arrives in the same batch, so the two are not distinguishable by behaviour.

## 7. Assumptions (where DESIGN is ambiguous, the reading the tests encode)

1. **Module homes.** References API is imported through one barrel, `test/support/refs.ts` (`references/{scan,usage,projectInfo,resolver,index}`, `parsers/index`); shared types through `test/support/types.ts` (`core/types`); `ManualClock`/`ManualScheduler`/`EventLog` from `core/clock`, `core/eventLog`; `buildWebviewHtml`/`makeNonce` from `core/webviewHtml`. If a module moves, only those barrels change.
2. **`api.testing.advance(0)` is a pure model refresh** (clock does not move, `onDidUpdate` fires). The integration helpers use it to re-read state.
3. **`parseImports` order is not specified**: tests sort by (line, specifier).
4. **Python relative imports**: the specifier may or may not include the leading dots; tests strip them and assert `relativeLevel` separately.
5. **Go grouped imports**: each member's `[line, endLine]` must cover the member's own line (a statement may report the whole group's range).
6. **Java/Kotlin wildcards**: compared after stripping a trailing `.*`; they must bind nothing.
7. **Rust `use`**: only the specifier prefix and the union of bindings are asserted (brace group = one or several statements).
8. **Ruby / PHP relative markers** are not asserted (encoding left to the Builder); only the path tail is.
9. **`export ... from` creates no bindings** (the re-exported names are not locals of the file). `import x = require()` kind may be `import` or `require`.
10. **Markdown links** are optional per the design: tests accept support or a recorded Deviation (the Builder implemented it, so the full assertions run).
11. **Config numerics**: `Infinity` may clamp or fall back to the default (only "in range" asserted); `idleTimeoutMs`/`windowMs` are not rounded, `maxFiles`/`maxFileSizeKb` are.
12. **Tracker**: external dedupe is asserted at 299 ms (dropped) and 301 ms (accepted) only, since the boundary is unspecified; shrinking `maxFiles` via `setOptions` must be honoured by the next `record` (size never stays above the cap); `msSinceOwnSave < 0` is treated as "just saved".
13. **`buildRows`** receives `tracked` already in tracker order (recency desc) and keeps that order; referenced rows sort by `refCount` desc then key asc.
14. **Decoration churn (design intent, DESIGN 1/10)**: a per-edit counter must not make the native decoration change; tested with `changedKeys` (the Builder recorded this as a Deviation).
15. **`buildStatus`**: with only idle edited rows either the plain label or the first idle row is accepted.
16. **Tree**: a folder whose only child is a *file* is not compacted; only folder-only chains merge.
17. **Webview**: `ul.fs-tree` may exist in the empty state (only "no `li`" is asserted); a folder toggle must `preventDefault()` on Enter, otherwise a real browser also fires `click` and toggles twice; Space on the toggle is native and not asserted; `lastSeq` initial value is not asserted.
18. **Collapsed state restore**: after the first snapshot a restored collapsed folder stays collapsed (Builder Deviation: first snapshot is a baseline); asserted only in `bundle.test.ts`.
19. **Integration naming**: `x.single.test.ts` / `x.multi.test.ts` / `x.none.test.ts` pin a suite to a launch variant, untagged suites run in all three. Settings are written at `Global` scope (isolated `--user-data-dir`), tests create uniquely named scratch directories, and every wait is a bounded re-read of state, never a fixed sleep.
20. **Fake clock vs real events**: VS Code reports the first edit of a clean document and its dirty-state change as two events; the helper `typeAndWait` waits until the edit is recorded before advancing the fake clock so the 150 ms settle timer cannot race the second event.
21. **Fixtures** carry a `.fixture` suffix (stripped on copy) so deliberately odd sources never reach `tsc`, `eslint` or the `.vsix`.
22. **Performance** budgets are best-of-N wall times (3 or 5 runs) to tolerate scheduler noise; budgets are those of the design (400 ms / 1000 ms / 20 ms).

## 8. What I need from the Builder

1. Optional but requested: `FileShakeApi.testing.pendingTimers(): number` (see 5).
2. Nothing blocks Phase 2. If any module is renamed or any `K` value changes, tell me: the literal-value tests (`constants.test.ts`, `manifest.test.ts`) will fail by design.
3. Please keep `lastSeq`-style details and the Deviations list current: several tests read DESIGN.md's `## Deviations` (markdown support) and the manifest.

## 9. How to re-run

See `test/README.md`. Short form: `npm run test:unit`; `npm run lint`; `FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm run test:integration`.
