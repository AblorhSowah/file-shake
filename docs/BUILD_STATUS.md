# BUILD_STATUS (Builder)

Maintained by the Builder after every milestone. A successor must be able to continue from this file.

## Current milestone: 0.2.0 (persistence + two users) done on top of M0..M7 and the Phase 2 fixes (QA-002..QA-006). Remaining: publish to the Marketplace (needs a publisher account), see "Release checklist" below.

## Milestone log

### M0 - scaffold + npm install: DONE
- Files: `package.json` (exact pinned versions, full manifest per DESIGN 13), `.npmrc` (save-exact, no fund/audit noise), `tsconfig.json`, `src/webview/tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `.vscodeignore`, `LICENSE`, `.gitignore`.
- `npm install` (run once, by Builder only): `added 353 packages in 51s`, exit 0 (warnings only: deprecated inflight/glob inside mocha/vsce; install-scripts notice for esbuild/vsce-sign, ignored). `npm ls --depth=0` matches DESIGN 3 exactly.

### M1 - core basics: DONE
`src/core/{constants,types,pathUtils,clock,eventLog,config,intensity,activityTracker,sourceClassifier,burstGuard,glob}.ts`.
All DESIGN 6 worked-example tables were checked with a scratch script (all match, incl. shakeParams values).

### M2 - references: DONE
`src/core/references/{scan,usage,projectInfo,resolver,index}.ts`, `parsers/{index,util,jsTs,python,go,jvm,cfamily,rust,ruby,php,css,html,markdown}.ts` (markdown links implemented, no Deviation needed).
Counting examples (1)-(4) of DESIGN 14 give 4/1, 3/3, 2, 5. Perf: 400 KB / 5000-line TS file analysed in ~150 ms; pathological inputs (500 KB of `(`, `"a"`, backticks, `import `, `'`, `/*`, `(/[`) across 7 languages all under 300 ms.

### M3 - view model / protocol: DONE
`src/core/{viewModel,tree,decorations,statusText,protocol,webviewHtml}.ts`.

### M4 - webview: DONE and looked at
`src/webview/{app,main}.ts`, `media/webview.css`. Verified in a real headless Chromium with the browser-automation skill on a mock page (mock page + driver scripts live in the session scratchpad, not in the repo):
- green rows (rgb 63,185,80) and yellow rows (rgb 227,179,65), badges, meters, folder counts with role dot; light theme screenshot also checked.
- computed `transform` of a shaking row changes frame to frame (matrix with translate/rotate), idle row `none`.
- reduced motion (`emulateMedia`) -> `data-motion="off"`, zero `.is-shaking`, `animation-name: none`, meters and badges still present.
- folder collapse persists via `setState`, auto-expands when a new file appears, click posts `{type:'open', id}`, row removal -> `.is-leaving` then removed after 400 ms, revival works, colour override applies, disabled state, out-of-order seq ignored, hostile file name `<img src=x onerror=alert(1)>.ts` rendered as text (0 injected `<img>`), 0 console errors.

### M5 - adapters + extension.ts: DONE
`src/vscode/{uriKey,config,decorationProvider,statusBar,shakeViewProvider,referenceService,controller,editWatcher}.ts`, `src/extension.ts` (exports `FileShakeApi`, `activate`, `deactivate`).
`npm run build` OK (`dist/extension.js` 211 KB unminified, `dist/webview.js` 21 KB). Not yet launched in a real VS Code by the Builder (Tester owns the integration suite; M7 includes the CLI install check).

### M6 - icon, README, CHANGELOG, LICENSE: DONE
`scripts/make-icon.mjs` -> `media/icon.png` (128x128 RGBA, 879 bytes, looked at: dark rounded tile with one green and two yellow bars). `README.md` (states DESIGN 2 items 1-6, DESIGN 9 reliability, reference limits, commands, settings, privacy), `CHANGELOG.md`, `LICENSE` (MIT, "Copyright (c) 2026 File Shake contributors").

### M7 - package + install: DONE
- `npm run package` (runs `vscode:prepublish` = production build first) -> `file-shake-0.1.0.vsix`, 53,149 bytes, 10 files: `[Content_Types].xml`, `extension.vsixmanifest`, `extension/{LICENSE.txt, changelog.md, readme.md, package.json, dist/extension.js (102 KB), dist/webview.js (11 KB), media/icon.png, media/webview.css}`. No `.map`, `src`, `test`, `node_modules`.
- `npx vsce ls --no-dependencies` lists exactly the 8 source files expected by DESIGN 13.
- Isolated CLI install (env scrubbed of `ELECTRON_RUN_AS_NODE` and every `VSCODE_*`; `--user-data-dir`/`--extensions-dir` in the scratchpad): `Extension 'file-shake-0.1.0.vsix' was successfully installed.` and `--list-extensions --show-versions` prints `file-shake.file-shake@0.1.0`.
- Real VS Code smoke test (Builder scratch script, not in `test/`; VS Code 1.129.1 via `FS_VSCODE_EXE`-style local executable, `FILE_SHAKE_TEST=1`), run against BOTH the repo (dev build) and the unzipped production `.vsix` contents: activates; 5 commands incl. `fileShake.view.focus` registered; Explorer view resolved, posted `ready`, received a snapshot; `TextEditor.edit` -> row `edited/you`, decoration badge `●` with ThemeColor `fileShake.editedForeground`; `a.ts` importing `b.ts` -> `b.ts` referenced row, count 4 (1 import + 3 usages), badge `4`, ThemeColor `fileShake.referencedForeground`; status text `$(pulse) a.ts · typing · 1 ref`; `fs.writeFileSync` of another file -> `external` row; rows removed after idle + retain; `enable=false/true` applied live; toggle/clear/debug commands run. The smoke test found one real bug (first keystroke classified `external`), fixed - see DESIGN Deviations.

## Commands run and results (latest)
- `npm run build` -> exit 0.
- `npm run test:unit` -> 1197 tests, 1197 pass, 0 fail (Tester's unit + webview tests at the time of the last run).
- `npx eslint src scripts esbuild.mjs eslint.config.mjs` and `tsc -p tsconfig.json` and `tsc -p src/webview/tsconfig.json` -> clean (no `any`, no `innerHTML`/`eval`, no vscode/node imports in `src/core`).
- `npm run package` -> OK (see M7). `test:integration` was not run by the Builder (Tester-owned; `test/integration/` was still empty at the last check).
- `npx eslint .` -> clean for `src/` and `scripts/`; see "Open problems" for Tester-owned files.

## Open problems (not Builder files)
- `test/unit/parsers.test.ts:869` ESLint `no-control-regex` (regex with `\x00`) and `test/unit/staticChecks.test.ts:155` `no-unused-vars` (`i`): `npm run lint` fails on them (`eslint .` is clean for everything the Builder owns). Tester-owned.
- `test/unit/protocol.test.ts` lines 100-112: `tsc -p test/tsconfig.json` errors (TS2790/TS2322/TS2740: `delete` on required fields, `string` vs `Json`): `npm run typecheck` fails on it. Tester-owned.
- `esbuild.mjs --tests` skips `test/integration/runTest.ts` (it runs under tsx and imports @vscode/test-electron). Recorded in DESIGN Deviations.

## Notes for a successor
- Source/WorkspaceRoot behaviour: `loadProjectInfo` keeps the roots it is given; the adapter (`referenceService.ts`) passes `[dirname(file)]` for files outside every workspace folder.
- `analyzeReferences` blanks the exact source spans of import statements before counting usages (so `import {a} from 'x'; a()` on ONE line still counts the usage); `countUsages` itself keeps the documented line-based `excludeLines` parameter.
- `docs/DESIGN.md` Deviations section lists every departure from the contract.

## Follow-up: test seam
- pendingTimers added: `FileShakeApi.testing.pendingTimers(): number` returns `ManualScheduler.pending` (one shared scheduler for controller, referenceService and editWatcher, including the 150 ms dirty-state parking timer). Test mode only. Recorded in DESIGN Deviations.

## Phase 2 fixes (after the Tester's adversarial pass; all reproduced in real VS Code first)
- QA-003 `controller.ts`: `rerequestActive` -> `rerequestShown` (active files, plus idle ones while `showWhenIdle` keeps them listed). Idle rows no longer lose their references after a rename.
- QA-004 `controller.ts`: `applyConfig` calls `ensureTick()` when `needsTick()`, so turning `showWhenIdle` off schedules the removal of idle rows.
- QA-005 `editWatcher.ts` + `controller.ts` + `core/activityTracker.ts`: `renameUnder` returns a count, `onRenamed` returns whether state moved, and the watcher treats the rename's echo as VS Code's own write (`recentMoves`, `lastOwnWriteAt`) so a typed file stays `you`.
- QA-006 `editWatcher.ts`: `external` document events pass `BurstGuard` (reason `burst`).
- QA-002 `referenceService.ts`: cache key is `doc:<identity>:<version>`. Not demonstrable on VS Code 1.129.1 (the text model outlives the editor), see DESIGN Deviations.
- Test-side changes: `test/integration/suite/75-adversarial.single.test.ts` (QA-006 wait also accepts `burst`), `test/integration/suite/76-folders.multi.test.ts` (rewrites the probe file every 500 ms until the new folder's watcher is live; a single write raced VS Code's asynchronous watcher start and failed about half the time on the unmodified code too), `test/unit/activityTracker.test.ts` (`renameUnder` return value).

## Release checklist
- `npm run lint`, `npm run test:unit` (1284), `FS_VSCODE_EXE=... npm run test:integration` and `FS_INSTALLED_VSIX=$PWD/file-shake-0.2.0.vsix ... node --import tsx test/integration/runTest.ts` (141 pass, 1 skipped) are green.
- `npm run package` -> `file-shake-0.2.0.vsix` (10 files, about 52 KB). Local install: `code --install-extension file-shake-0.2.0.vsix`.
- Not done: `vsce publish` / Open VSX. `package.json` still has placeholders: `publisher` is `file-shake` (must be a real Marketplace publisher id you own, and the extension id becomes `<publisher>.file-shake`) and `repository.url` is `https://github.com/OWNER/file-shake.git` (the package script passes `--allow-missing-repository` because of it). Publishing also needs a personal access token. Also not done: Windows/Linux runs, VS Code 1.85 floor run.

## 0.2.0: persistence and the two users
- Spec and rules: `docs/DESIGN.md` section 15 and the last Deviations bullet.
- Core: `ActivityTracker` (`persist`, `release`, superseded-file rule), `viewModel` (`ViewRow.actor`, per-user source cap), `tree` (`buildActorTree`, id prefix), `protocol` (`actor`), `config` (`persistUntilNextFile`).
- Adapters: `controller` (`keepsIdle`, `onActiveEditorChanged`, `onWindowFocusChanged`, `noteOpenedFromView`), `extension` (editor and window listeners, two test seams), `shakeViewProvider` (`onOpenRow`).
- Webview: sections rendered by the existing folder code (`data-actor`), `media/webview.css` section styles.
- Tests: tracker persist mode (14), view model actor (5), tree sections (7), protocol actor (3), webview sections (6), integration suite `77-persistence.single` (13, real VS Code). Seven older integration tests assert timed removal and set `persistUntilNextFile` to `false` explicitly. Version pins moved to 0.2.0.
- Checked by mutation in scratch copies (each killed by the matching tests): switching files never releases you; window blur never releases you; the view-click guard removed; an idle file never replaced by the same user's next file.
- Release checklist above still applies; the package is now `file-shake-0.2.0.vsix`.
