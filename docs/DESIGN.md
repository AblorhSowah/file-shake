# File Shake — Design Contract (v1)

Source of truth for Builder and Tester. `BRIEF.md` is the product intent; **this file wins** where they differ (see §2). Builder deviations go in `## Deviations` at the bottom, never silently. Everything marked **[spike]** was executed by the Architect in a scratch project with the exact pinned versions (npm install, `tsc`, esbuild, ESLint, `node:test`+tsx+jsdom, `vsce package`, a real VS Code 1.129.1 launch through `@vscode/test-electron`, and a CLI `.vsix` install) and works.

## 1. Platform facts (verified against `@types/vscode@1.85.0` typings, VS Code `main` sources, current docs)

| Capability | Verified fact | Consequence |
|---|---|---|
| `FileDecoration` | `new FileDecoration(badge?, tooltip?, color?: ThemeColor)`, `propagate?: boolean`. Validation (`extHostTypes.ts`): badge must be **<= 2 characters**, else the decoration is dropped with a log warning. Decoration with no badge/color/tooltip is invalid. | Native badge is a 1-2 char glyph only. `typing` / `external` / `×N refs` text exists **only in the webview**. |
| `onDidChangeFileDecorations` | `Event<undefined \| Uri \| Uri[]>`. On `Uri[]` the workbench eagerly re-fetches those URIs (so `propagate` reaches folders whose children are not rendered). `undefined` flushes everything (expensive). More than 250 URIs per event are capped to one-per-folder. | Fire with exact changed URIs only, only on state transitions (not per keystroke; decoration carries no intensity). Never fire `undefined`. |
| `propagate: true` | Parent folders get the colour plus a "bubble" dot, tooltip "Contains emphasized items" (`decorationsService.ts`). | Setting `fileShake.decorateFolders` (default true). |
| Theme colours | `contributes.colors` with `dark/light/highContrast/highContrastLight`. A `ThemeColor` id must be contributed or it renders uncoloured. Webviews receive **every registered colour** as `--vscode-<id with FIRST '.' replaced by '-'>` (`themeing.ts` uses `replace('.', '-')`, first dot only). | Colour ids must contain exactly one dot: `fileShake.editedForeground` -> `--vscode-fileShake-editedForeground`. One source of colour truth for native + webview. |
| Webview view in Explorer | `contributes.views.explorer: [{ "type": "webview", "id", "name" }]` + `registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden } })`. Auto-generated `<viewId>.focus` command exists. No `onView` activation event needed (>=1.74). | View id `fileShake.view`; focus via `fileShake.view.focus`. |
| Hidden webviews | "You cannot send messages to a hidden webview, even with `retainContextWhenHidden`"; `postMessage` resolves `false` when undeliverable. Without retain, the document is destroyed on hide and re-created on show. | Protocol is **snapshot-based** (full state each message) + `ready` handshake. `retainContextWhenHidden: false` (docs: high memory cost). |
| Webview CSP | Per the CSP spec, CSSOM writes (`el.style.setProperty`) are allowed under `style-src ${cspSource}`; `style="..."` in markup / `setAttribute('style')` are blocked (jsdom does not enforce CSP, so this is enforced by lint + review; the nonce'd script load itself was verified in real VS Code). | Webview sets CSS custom properties **only** via `style.setProperty`. Never `innerHTML`. |
| `FileSystemWatcher` | Recursive watchers on paths inside the workspace reuse the default workspace watcher, so events obey `files.watcherExclude` (default excludes `.git/objects`, `node_modules/*/**`, ...). Paths are reported with on-disk casing. Symlinks not followed. Rename/delete of watched root not reported. | Use `RelativePattern(folder, '**/*')` per workspace folder. Files hidden by `files.watcherExclude` give no disk events (document events still fire for open docs). Documented limit. |
| `onDidChangeTextDocument` | Fires on content change **and on dirty-state change (empty `contentChanges`)**. `reason: TextDocumentChangeReason.Undo \| Redo \| undefined`. Fires for non-`file` schemes (output, git, untitled, notebook cells). A clean open document reloaded from disk fires it with `document.isDirty === false`. | Basis of the source heuristic (§9). Filter scheme `file`; ignore empty changes. |
| `onDidRenameFiles` | Fires for user gestures + `workspace.applyEdit` only, **not** for disk renames; one event per folder rename. | Disk renames arrive as watcher delete+create. |
| `window.state.focused`, `onWillSaveTextDocument`/`onDidSaveTextDocument` | Available since long before 1.85. | Used by classifier/self-save guard. |
| Activation | `onStartupFinished` = after startup, no startup slowdown. Contributed commands/views need no explicit activation events. | `activationEvents: ["onStartupFinished"]`. |
| Remote | Extension must run where files are. | `extensionKind: ["workspace"]`. |
| `@vscode/vsce` | `vsce package --no-dependencies --allow-missing-repository` works with everything bundled **[spike]**. `LICENSE` ships as `extension/LICENSE.txt`. `@types/vscode` must be <= `engines.vscode` or vsce refuses. | Pin `@types/vscode@1.85.0` with `engines.vscode: "^1.85.0"`. |
| `@vscode/test-electron` | `runTests({ extensionDevelopmentPath, extensionTestsPath, extensionTestsEnv, launchArgs, version })`; test path exports `run(): Promise<void>`. | See §13. |

## 2. Brief requirements that cannot be met exactly as written (honest alternatives)

1. **Native Explorer rows cannot shake** (known). Only colour + <=2-char badge + tooltip are native; shaking lives in the webview view.
2. **Badges `typing` / `external` / `×N refs` cannot be native** (2-char limit). Native badge glyphs: edited-by-you `●`, edited-external `◆`, referenced = decimal count (`1`..`9`, `9+` when >=10). Full text in webview + tooltips.
3. **"Colours configurable + theme colours"**: native decorations can only take their colour from contributed theme colours, so users override those via `workbench.colorCustomizations`. The settings `fileShake.colors.edited|referenced` (empty = follow theme) affect **only the webview**. README must say so. Defaults: dark/HC = brief hex (`#3fb950`, `#e3b341`); light uses darker tones for contrast (§11).
4. **Telling Claude Code from "the user"**: impossible via the API (no writer identity). We distinguish *typing in the focused editor* (`you`) from *any other change* (`external`: Claude Code, git, formatters, build tools, other extensions). Label is `external`, never "Claude". See §9 for reliability.
5. **Reference count** is heuristic (regex/token scan, not an AST): shadowing is not modelled; Go/Java same-package implicit references and bundler aliases are not found (§7.6).
6. **"Yellow while typing/editing"**: yellow rows exist only while a source file is active (or `showWhenIdle`); merely focusing a file does not surface references.
7. Layout refinement: webview is TypeScript in `src/webview/` bundled to `dist/webview.js` (strict TS + jsdom-testable); only CSS/icon live in `media/`.

## 3. Pinned toolchain (looked up with `npm view`, installed together without peer errors **[spike]**)

All exact (no `^`). Runtime bundled libs go in `devDependencies` (esbuild inlines them; `.vsix` has no `node_modules`).

| Package | Version | Why |
|---|---|---|
| typescript | **6.0.3** | `latest` is 7.0.2 but `typescript-eslint@8.72.1` peers `typescript <6.1.0`; 6.0.3 is the newest compatible |
| @types/vscode | **1.85.0** | API surface == `engines.vscode ^1.85.0`; compile guarantees no newer API is used |
| @types/node | **18.19.130** | VS Code 1.85 extension host is Node 18; prevents Node>=20 APIs (e.g. `toSorted`, `fs.glob`) |
| esbuild | 0.28.2 | bundler (npm warns about its postinstall; ignore, binary comes via optional dep) |
| @vscode/vsce | 4.1.0 | packaging (needs Node >= 22; installed Node is 24) |
| @vscode/test-electron | 3.1.0 | integration host |
| mocha / @types/mocha | **10.8.2** / 10.0.10 | mocha 12 needs Node >= 20.19, which would block running old VS Code; 10.x keeps `VSCODE_TEST_VERSION=1.85.0` possible |
| tsx | 4.23.15 | TS loader for `node --test` and the test launcher |
| jsdom / @types/jsdom | 30.1.3 / 30.0.0 | webview tests |
| eslint / @eslint/js / typescript-eslint / globals | 10.14.0 / 10.0.1 / 8.72.1 / 17.13.0 | flat-config lint |
| picomatch / @types/picomatch | 4.0.7 / 4.0.3 | exclude globs (bundled) |
| jsonc-parser | 3.3.1 | tsconfig/jsconfig parsing (comments, trailing commas; bundled) |

Unit runner: **`node:test` + `node:assert/strict` + tsx** (no vitest: avoids vite). Webview: `jsdom` constructed manually inside `node:test`. Integration: mocha 10 inside VS Code. Not used: `@vscode/test-cli`, `glob`, `minimatch`.

### 3.1 Verified config starting points (copy, then extend)

`tsconfig.json` (extension host + core; **no DOM lib**, so DOM use in core is a compile error): `{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","lib":["ES2022"],"types":["node"],"strict":true,"noUncheckedIndexedAccess":true,"noImplicitOverride":true,"noFallthroughCasesInSwitch":true,"isolatedModules":true,"verbatimModuleSyntax":true,"skipLibCheck":true,"noEmit":true,"rootDir":".","esModuleInterop":true},"include":["src/core/**/*.ts","src/vscode/**/*.ts","src/extension.ts"]}`
`src/webview/tsconfig.json`: `extends ../../tsconfig.json`, `lib:["ES2022","DOM","DOM.Iterable"]`, `types:[]`, `include:["./**/*.ts"]` (imported `core` files are pulled in by tsc automatically). **The webview may import only `core/types`, `core/constants`, `core/intensity`, `core/protocol`, `core/tree`** — anything importing `picomatch`/`jsonc-parser` (`glob`, `references/**`, `config`) breaks the browser bundle; use `ReturnType<typeof setTimeout>` (never `NodeJS.Timeout`/`number`) in `core/clock.ts` so it type-checks under both libs.
`test/tsconfig.json`: `extends ../tsconfig.json`, `lib:["ES2022","DOM"]`, `types:["node","mocha"]`, `rootDir:".."`, `include:["./**/*.ts","../src/**/*.ts"]`.
`esbuild.mjs`: three bundles — (a) `src/extension.ts` -> `dist/extension.js` (`platform:node, format:cjs, target:node18, external:['vscode'], mainFields:['module','main']` — **mandatory**: without `module` first, esbuild bundles jsonc-parser's UMD build and activation fails at runtime with `Cannot find module './impl/format'` **[found in the real-VS Code spike]**); (b) `src/webview/main.ts` -> `dist/webview.js` (`platform:browser, format:iife, target:es2022`); (c) with `--tests`: every `test/integration/**/*.ts` as separate entry -> `out/integration/**` (`outbase:test/integration`, cjs, `external:['vscode','mocha']`). `--production` => `minify:true, sourcemap:false`; else `sourcemap:true`. `--watch` uses `context().watch()`.
`eslint.config.mjs` (flat; `tseslint.config(...)`): ignores `dist/** out/** node_modules/** .vscode-test/** *.vsix`; `js.configs.recommended` + `tseslint.configs.recommended`; globals node for `**/*.mjs`, `src/**`, `test/**`; browser globals for `src/webview/**`; rules: `@typescript-eslint/no-explicit-any: error`; `no-restricted-properties` banning `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` in `src/webview/**`; `no-restricted-imports` banning `vscode`, `node:*`, `fs`, `path`, `os`, `child_process` in `src/core/**` and `vscode` in `src/webview/**` (core must stay pure; the webview bundle consumes only `src/core`).
`.vscodeignore`: `**` then un-ignore `dist/extension.js`, `dist/webview.js`, `media/**`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE` (spike result: 8 files, 4 KB).

## 4. Final layout

```
package.json tsconfig.json esbuild.mjs eslint.config.mjs .vscodeignore LICENSE README.md CHANGELOG.md
scripts/make-icon.mjs            # dependency-free zlib PNG writer -> media/icon.png (128x128)
media/ icon.png  webview.css
src/extension.ts                 # activate/deactivate wiring only; returns FileShakeApi
src/core/                        # PURE: no vscode / node imports
  constants.ts types.ts pathUtils.ts config.ts clock.ts intensity.ts activityTracker.ts
  sourceClassifier.ts burstGuard.ts eventLog.ts viewModel.ts tree.ts decorations.ts
  statusText.ts protocol.ts webviewHtml.ts glob.ts
  references/ index.ts scan.ts usage.ts resolver.ts projectInfo.ts
    parsers/ index.ts jsTs.ts python.ts go.ts jvm.ts cfamily.ts rust.ts ruby.ts php.ts css.ts html.ts markdown.ts
src/vscode/                      # adapters (import vscode)
  config.ts editWatcher.ts referenceService.ts controller.ts decorationProvider.ts shakeViewProvider.ts statusBar.ts uriKey.ts
src/webview/ main.ts app.ts      # app.ts has no side effects on import; main.ts = acquireVsCodeApi + mountApp + message listener
test/ unit/ webview/ integration/ fixtures/
docs/ BRIEF.md DESIGN.md QA_REPORT.md
```

## 5. Constants (`core/constants.ts`, `export const K = {...} as const`)

| Name | Value | Meaning |
|---|---|---|
| RATE_SCALE | 6 | units/sec at which intensity = 1-1/e (0.632) with sensitivity 1 |
| FLOOR | 0.12 | minimum intensity while any event is in the window |
| MIN_SPAN_MS | 500 | min denominator span for rate |
| MAX_EVENT_WEIGHT | 12 | cap per document-change event |
| EXTERNAL_EVENT_WEIGHT | 6 | weight of any external event (size unknown) |
| EXTERNAL_DEDUPE_MS | 300 | drop 2nd external event for same file within this |
| SELF_SAVE_WINDOW_MS | 2000 | watcher events this soon after our own save are ignored |
| RETAIN_AFTER_IDLE_MS | 4000 | idle (stale) rows linger this long before removal (when `showWhenIdle=false`) |
| REF_SATURATION | 32 | reference count that maps to intensity 1.0 at sensitivity 1 |
| MAX_REFERENCE_SOURCES | 3 | max edited files whose references are shown |
| MAX_REFS_PER_SOURCE | 30 | cap targets per analysed file (top by count, then path) |
| MAX_STATEMENTS | 2000 | parser stops after this many import statements |
| REF_DEBOUNCE_MS | 400 | quiet time after last edit before (re)analysing a source |
| MAX_PROBES | 400 | max `isFile`/`listDir` probes per analysis |
| ANALYSIS_TIMEOUT_MS | 1500 | cooperative deadline per analysis (checked between statements) |
| TICK_MS | 200 | model refresh while anything is active |
| BURST_LIMIT / BURST_WINDOW_MS / BURST_COOLDOWN_MS | 30 / 1000 / 3000 | >30 distinct files/sec -> drop external watcher events for 3 s |
| LEAVE_MS | 400 | webview fade-out before DOM removal |
| EVENT_LOG_SIZE | 50 | debug ring buffer |
| SHAKE: AMP_MIN / AMP_RANGE | 0.5 / 3.5 px | `amp = 0.5 + 3.5*i` |
| SHAKE: DUR_BASE / DUR_RANGE | 160 / 100 ms | `dur = round(160 - 100*i)` (one cycle) |
| SHAKE: ROT_BASE / ROT_RANGE | 0.2 / 1.0 deg | `rot = 0.2 + 1.0*i` |
| MAX_EVENTS_PER_FILE | 512 | memory cap of retained events per file |

## 6. The math (`core/intensity.ts`) — pure, no clocks

```ts
export function clamp01(x: number): number;                 // non-finite (NaN, ±Infinity) -> 0; else min(1, max(0, x))
export function clampSensitivity(s: number): number;         // non-finite -> 1; else clamp to [0.25, 4]
export function changeWeight(chars: number): number;         // chars<=0 or non-finite ->0; else min(12, 1 + log2(chars))
export interface ContentChangeSize { inserted: number; deleted: number }   // text.length / rangeLength
export function typingWeight(changes: readonly ContentChangeSize[]): number; // min(MAX_EVENT_WEIGHT, Σ changeWeight(max(inserted, deleted))) ; [] -> 0
export interface WeightedEvent { at: number; weight: number }
export function windowRate(events: readonly WeightedEvent[], now: number, windowMs: number): number; // units/sec
export function rateToIntensity(rate: number, sensitivity: number): number;
export function idleFade(sinceLastMs: number, idleTimeoutMs: number): number;
export function editIntensity(events: readonly WeightedEvent[], now: number, o: { windowMs: number; idleTimeoutMs: number; sensitivity: number }): number;
export function referenceIntensity(count: number, sensitivity: number): number;
export function shakeParams(intensity: number): ShakeParams;   // ShakeParams { amp (px), dur (ms), rot (deg) } lives in types.ts
```
Exact definitions:
- `windowRate`: live = events with `at <= now` and `now - at < windowMs`. none -> 0. `span = clamp(now - min(at of live), MIN_SPAN_MS, windowMs)`. `rate = Σweight / (span/1000)`.
- `rateToIntensity`: `rate` not >0 or non-finite -> 0; else `clamp01(max(FLOOR, 1 - exp(-rate * clampSensitivity(s) / RATE_SCALE)))`.
- `idleFade = clamp01(1 - since/idle)` with `since` floored at 0; `idle<=0` -> 0.
- `editIntensity`: effective window `W = max(windowMs, idleTimeoutMs)` (so an active file can never have rate 0 when the user sets a tiny window); `since = max(0, now - max(at))`; `since >= idleTimeoutMs` -> 0 (this is exactly the `idle` phase boundary); else `clamp01(rateToIntensity(windowRate(events, now, W), sensitivity) * idleFade(since, idle))`. Empty events -> 0.
- `referenceIntensity = clamp01(log2(1+count) * clampSensitivity(s) / log2(1+REF_SATURATION))`; count not >0 -> 0.
- `shakeParams(i)`: `i<=0 or non-finite` -> `{amp:0, dur:160, rot:0}`; else `i=clamp01(i)`, `amp=round2(0.5+3.5i)`, `dur=round(160-100i)`, `rot=round2(0.2+1.0i)` (`round2 = Math.round(x*100)/100`).
CSS mapping: `--fs-amp: ${amp}px; --fs-dur: ${dur}ms; --fs-rot: ${rot}deg; --fs-level: ${round3(intensity)}`.

Worked examples (Tester asserts, tolerance 1e-3 for intensities, exact for `amp/dur/rot`; windowMs=3000, idle=2500, sens=1, events at T0 unless stated):

| Input | Output |
|---|---|
| changeWeight(0,1,2,4,8,50,500,4095,1e5) | 0, 1, 2, 3, 4, 6.644, 9.966, 12, 12 |
| rateToIntensity(rate, 1): 0, 0.1, 0.5, 1, 2, 3, 5, 6, 10, 12, 20, 60 | 0, 0.12, 0.12, 0.1535, 0.2835, 0.3935, 0.5654, 0.6321, 0.8111, 0.8647, 0.9643, 1.0 |
| rateToIntensity(5, s): s=0.25, 0.5, 1, 2, 4, NaN(->1), 100(->4) | 0.1881, 0.3408, 0.5654, 0.8111, 0.9643, 0.5654, 0.9643 |
| 1 keystroke (w=1) at T0; now = T0+0 / 250 / 500 / 1000 / 1500 / 2000 / 2499 / 2500 | rate 2/2/2/1/0.667/0.5/0.4/0.4 ; intensity 0.2835 / 0.2551 / 0.2268 / 0.0921 / 0.048 / 0.024 / 0 (<0.001) / 0 |
| 15 keystrokes w=1 at T0+200k (k=1..15), now=T0+3000 (5 keys/s) | rate 5.357 (span 2800), intensity 0.5905 |
| paste of 500 chars (w=9.966) at T0; now=T0+0 / 500 / 1000 / 2000 / 2500 | intensity 0.9639 / 0.7711 / 0.486 / 0.1128 / 0 |
| external write (w=6) at T0; now=T0+0 / 500 / 1000 / 1250 / 2000 / 2500 | 0.8647 / 0.6917 / 0.3793 / 0.2753 / 0.0787 / 0 |
| referenceIntensity(count, 1): 0, 1, 2, 3, 5, 7, 10, 15, 31, 32, 100 | 0, 0.1982, 0.3142, 0.3965, 0.5124, 0.5947, 0.6858, 0.793, 0.9912, 1, 1 |
| referenceIntensity(count, 2): 1, 3, 7, 15 | 0.3965, 0.793, 1, 1 |
| shakeParams(i): 0 / 0.1 / 0.25 / 0.5 / 0.75 / 1 | {0,160,0} / {0.85,150,0.3} / {1.38,135,0.45} / {2.25,110,0.7} / {3.13,85,0.95} / {4,60,1.2} (amp,dur,rot) |
| shakeParams(referenceIntensity(5,1)=0.5124) | {2.29, 109, 0.71} |
Boundaries: NaN/negative/Infinity inputs never throw and yield 0 intensity / zero shake; `shakeParams(5)` == `shakeParams(1)`.

## 7. Core contracts

### 7.1 `core/types.ts` (ALL shared data types live here and only here; other modules import them), `pathUtils.ts`, `clock.ts`, `eventLog.ts`
```ts
export type FileKey = string;               // normalised absolute POSIX path; drive letter lower-cased: "/home/u/p/a.ts", "c:/p/a.ts", UNC "//srv/share/a.ts"
export type EditSource = 'you' | 'external';
export type Phase = 'active' | 'idle';
export type Role = 'edited' | 'referenced';
export interface WorkspaceRoot { key: FileKey; name: string }
export interface ShakeParams { amp: number; dur: number; rot: number }          // px, ms, deg
export interface TrackedFile { key: FileKey; source: EditSource; phase: Phase; intensity: number; rate: number /* windowRate at now, even when idle */; firstEditAt: number; lastEditAt: number; editCount: number }
export interface ViewRow { id: FileKey; uri: string; name: string; dir: string; folderPath: string[]; role: Role; source: EditSource | null /* null for referenced */; phase: Phase; intensity: number; shake: ShakeParams; refCount: number /* 0 for edited */; badge: string; tooltip: string }
export interface Snapshot { v: 1; seq: number; enabled: boolean; animate: boolean; colors: { edited: string; referenced: string } /* '' = follow theme */; rows: ViewRow[] }
export interface DecorationSpec { role: Role; badge: string; tooltip: string; colorId: 'fileShake.editedForeground' | 'fileShake.referencedForeground'; propagate: boolean }
export interface Clock { now(): number }                                   // ms
export interface Scheduler { setTimeout(fn: () => void, ms: number): { cancel(): void } }
export class ManualClock implements Clock { constructor(start?: number); now(): number; advance(ms: number): void; set(t: number): void }
export class ManualScheduler implements Scheduler { constructor(clock: ManualClock); setTimeout(...); advance(ms: number): void /* advances clock, runs due callbacks in time order, incl. ones scheduled meanwhile */; readonly pending: number }
export const systemClock: Clock; export const systemScheduler: Scheduler;
// pathUtils.ts (all inputs may contain '\\'; outputs never do)
export function normalizePath(p: string): string;     // '\'->'/', collapse '//' (keep UNC lead), resolve '.' '..' (never above root), strip trailing '/', lower-case 'C:'. Root stays "/" or "c:/". Empty -> "".
export function dirname(p: string): string; export function basename(p: string): string; export function extname(p: string): string; // ext incl dot, '' for dotfiles like ".env"
export function joinPath(...parts: string[]): string;  // join then normalizePath; an absolute later part resets
export function isAbsolutePath(p: string): boolean;    // "/x", "c:/x", "c:\x", "//srv/x"
export function isUnder(base: FileKey, p: FileKey): boolean;   // p === base || p startsWith base + '/' ; root-safe
export function relativeTo(base: FileKey, p: FileKey): string | undefined;   // "" when equal, undefined when not under
export function hasSegment(p: string, seg: string): boolean;   // e.g. 'node_modules'
export interface DisplayPath { name: string; dir: string; folderPath: string[] }
export function toDisplayPath(key: FileKey, roots: readonly WorkspaceRoot[]): DisplayPath;
```
`toDisplayPath`: longest matching root wins (nested roots). Single root: `folderPath = rel dir segments`, `dir = rel dir` ("" at root). Multiple roots: `folderPath = [root.name, ...segments]`, `dir = root.name + '/' + rel` (just `root.name` at root). Outside any root (or no folder open): `folderPath = ['(outside workspace)', ...absolute dir segments]`, `dir = absolute dir`.
```ts
// declared in types.ts:
export type ClassifyReason = 'no-content-change'|'saving'|'undo-redo'|'reload-from-disk'|'active-focused-edit'|'background-edit'|'disk-write'|'self-save'|'dedupe'|'excluded'|'burst'|'scheme'|'disabled'|'external-detection-off';
export interface LogEntry { at: number; key: string; origin: 'doc'|'watcher'; decision: 'you'|'external'|'ignore'; reason: ClassifyReason; weight: number }
// eventLog.ts:
export class EventLog { constructor(size?: number); add(e: LogEntry): void; entries(): readonly LogEntry[] /* oldest first, <= size */; clear(): void }
```

### 7.2 `core/activityTracker.ts`
```ts
export interface TrackerOptions { windowMs: number; idleTimeoutMs: number; retainAfterIdleMs: number; maxFiles: number; sensitivity: number; showWhenIdle: boolean }
export const DEFAULT_TRACKER_OPTIONS: TrackerOptions; // 3000, 2500, 4000, 40, 1, false
export interface EditInput { key: FileKey; source: EditSource; weight: number; at?: number }   // at defaults to clock.now()
export class ActivityTracker {
  constructor(clock: Clock, options?: Partial<TrackerOptions>);
  setOptions(patch: Partial<TrackerOptions>): void;
  record(input: EditInput): boolean;          // false = ignored: weight not finite or <=0; or source 'external' within EXTERNAL_DEDUPE_MS of the file's previous external event
  snapshot(): TrackedFile[];                  // prunes + removes expired at clock.now(); sorted lastEditAt desc, then key asc
  get(key: FileKey): TrackedFile | undefined; // same computation as snapshot for one file
  primary(): TrackedFile | undefined;         // first snapshot() entry with phase 'active'
  forget(key: FileKey): boolean; forgetUnder(prefix: FileKey): number /* key === prefix or under it */;
  renameUnder(oldPrefix: FileKey, newPrefix: FileKey): void; // re-keys state (also folder renames); overwrites existing target state
  clear(): void; readonly size: number;
}
```
Rules: a file's `source` is the source of its most recent accepted event. `phase = (now - lastEditAt) < idleTimeoutMs ? 'active' : 'idle'`; idle files report `intensity: 0`. Removed when `!showWhenIdle && now - lastEditAt >= idleTimeoutMs + retainAfterIdleMs`. Events older than `max(windowMs, idleTimeoutMs)` are dropped; at most `MAX_EVENTS_PER_FILE` kept (oldest dropped). If `size > maxFiles` after a record, evict the file with the smallest `lastEditAt` (ties: key asc). A clock that moves backwards clamps `since` to 0. `editCount` counts accepted events, lifetime of the entry.

### 7.3 `core/sourceClassifier.ts`, `burstGuard.ts`, `glob.ts`
```ts
export interface Classification { decision: 'you'|'external'|'ignore'; reason: ClassifyReason }
export interface DocChangeContext { contentChangeCount: number; isSaving: boolean; reason: 'undo'|'redo'|undefined; isDirtyAfter: boolean; isActiveEditorDoc: boolean; windowFocused: boolean }
export function classifyDocumentChange(c: DocChangeContext): Classification;
export interface WatcherContext { msSinceOwnSave: number | undefined }          // undefined = no save seen
export function classifyWatcherEvent(c: WatcherContext): Classification;
export class BurstGuard { constructor(clock: Clock, limit?: number, windowMs?: number, cooldownMs?: number); accept(key: FileKey): boolean }
export function createExcludeMatcher(globs: readonly string[], opts?: { nocase?: boolean }): (relPath: string) => boolean; // picomatch {dot:true}; relPath is POSIX; invalid glob entries are skipped, never throw; [] excludes nothing
export function relativeForMatch(key: FileKey, roots: readonly WorkspaceRoot[]): string; // relative to containing root, else absolute path without leading '/'
```
`classifyDocumentChange` — first matching row wins:

| # | Condition | Decision / reason |
|---|---|---|
| 1 | `contentChangeCount === 0` | ignore / no-content-change |
| 2 | `isSaving` (between will-save and did-save; format-on-save edits) | ignore / saving |
| 3 | `reason` is undo or redo | you / undo-redo |
| 4 | `!isDirtyAfter` (disk reload / revert) | external / reload-from-disk |
| 5 | `isActiveEditorDoc && windowFocused` | you / active-focused-edit |
| 6 | otherwise (dirty, but not the focused editor: WorkspaceEdit, rename refactor, agent API) | external / background-edit |

`classifyWatcherEvent`: `msSinceOwnSave !== undefined && < SELF_SAVE_WINDOW_MS` -> ignore / self-save; else external / disk-write. `BurstGuard.accept`: counts distinct keys in the last `windowMs`; when the count would exceed `limit` it enters cooldown for `cooldownMs` (all calls return false, reason 'burst'); keys seen again within the window do not increase the count.

### 7.4 `core/config.ts`
```ts
export interface FileShakeConfig { enable: boolean; enableAnimation: boolean; idleTimeoutMs: number; windowMs: number; maxFiles: number; excludeGlobs: string[]; editedColor: string; referencedColor: string; sensitivity: number; showWhenIdle: boolean; decorateFolders: boolean; detectExternalEdits: boolean; maxFileSizeKb: number; showStatusBar: boolean }
export const DEFAULT_CONFIG: FileShakeConfig;
export function sanitizeConfig(raw: Readonly<Record<string, unknown>>): FileShakeConfig;  // total: never throws
export function toTrackerOptions(c: FileShakeConfig): TrackerOptions;  // retainAfterIdleMs = K.RETAIN_AFTER_IDLE_MS
```
Ranges (clamp, `Math.round` for integers; non-number/NaN -> default): `idleTimeoutMs` [500, 60000] def 2500; `windowMs` [500, 30000] def 3000; `maxFiles` [5, 200] def 40; `sensitivity` [0.25, 4] def 1; `maxFileSizeKb` [16, 4096] def 512. Booleans: non-boolean -> default (all true except `showWhenIdle` false). `excludeGlobs`: non-array -> default; array -> keep only strings (so `[]` is valid). Colours: must match `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$` else `''` (= follow theme). Default `excludeGlobs`: `**/node_modules/**, **/.git/**, **/dist/**, **/out/**, **/build/**, **/coverage/**, **/.next/**, **/.venv/**, **/__pycache__/**, **/.vscode-test/**, **/*.min.js, **/*.map, **/*.log, **/*.vsix, **/package-lock.json, **/yarn.lock, **/pnpm-lock.yaml`.

### 7.5 `core/viewModel.ts`, `tree.ts`, `decorations.ts`, `statusText.ts`
```ts
// ViewRow / Snapshot / DecorationSpec are declared in types.ts
export interface ModelInput { tracked: readonly TrackedFile[]; references: ReadonlyMap<FileKey, ReferenceResult>; roots: readonly WorkspaceRoot[]; toUri(key: FileKey): string; sensitivity: number; maxFiles: number; showWhenIdle: boolean }
export function buildRows(i: ModelInput): ViewRow[];
```
`buildRows`: (1) every tracked file -> `edited` row (`intensity` from tracker, `shake = shakeParams(intensity)`, badge `typing` for you / `external`). (2) Sources = the first `MAX_REFERENCE_SOURCES` tracked files (recency order) that are `active` (any phase if `showWhenIdle`); a source without an entry in `references` (analysis pending/skipped) simply contributes nothing. (3) For each source target: skip if target is the source itself or is itself a tracked file (green wins); `refCount[target] += target.count` (sum across sources). (4) Referenced row: `phase = 'active'` if any contributing source is active else `'idle'`; `intensity = phase==='active' ? referenceIntensity(count, sensitivity) : 0`; `shake = shakeParams(intensity)`; badge `×N ref` / `×N refs` (`×` = U+00D7; N=1 -> `×1 ref`); tooltip `Referenced N× by a.ts, b.ts`. (5) Trim to `maxFiles`: all edited rows first (edited alone are capped at `maxFiles` by recency), then referenced by `refCount` desc, key asc. Output order: edited by `lastEditAt` desc, then referenced. Edited tooltips: `Edited by you (typing) · N edits` / `Changed outside the editor (external) · N edits`.
```ts
export type TreeNode = FolderNode | FileNode;
export interface FolderNode { kind: 'folder'; id: string; label: string; children: TreeNode[]; fileCount: number; topRole: Role | null; hasActive: boolean }
export interface FileNode { kind: 'file'; id: FileKey; row: ViewRow }
export function buildTree(rows: readonly ViewRow[]): TreeNode[];
```
`buildTree`: groups by `folderPath`. A folder's `id` = its full segment path joined by `/` (of the deepest folder of a compacted chain); **compaction**: a folder whose only child is a single folder is merged (`label` = `a/b`). Order: folders before files; each group sorted `a.localeCompare(b, 'en', { numeric: true })` on label/name (alphabetical, **never by intensity**, so shaking rows do not jump). `topRole` = `edited` if any descendant row is edited else `referenced`; `hasActive` = any descendant active; `fileCount` = descendant files.
```ts
export function buildDecorations(rows: readonly ViewRow[], o: { showWhenIdle: boolean; decorateFolders: boolean }): Map<FileKey, DecorationSpec>;
export function changedKeys(prev: ReadonlyMap<FileKey, DecorationSpec>, next: ReadonlyMap<FileKey, DecorationSpec>): FileKey[];  // keys added, removed, or whose spec differs by deep equality
```
Only rows with `phase==='active'` (or any phase when `showWhenIdle`) get a decoration (retained/fading rows get none). Badges: edited `you` `●`, `external` `◆`, referenced `refCount<=9 ? String(n) : '9+'`. Tooltip prefix `File Shake: `. **Invariant (tested): every badge is <= 2 UTF-16 units.**
```ts
export interface StatusInput { enabled: boolean; rows: readonly ViewRow[] }
export function buildStatus(i: StatusInput): { text: string; tooltip: string };
```
Rules: disabled -> `$(circle-slash) File Shake: off`. No `active` edited row (and not `showWhenIdle`) -> `$(pulse) File Shake`. Otherwise primary = first edited row with phase active (else first edited): `$(pulse) {name} · {typing|external}` plus ` · {R} refs` when R>0 (R = number of referenced rows; `1 ref`). E.g. `$(pulse) index.ts · typing · 3 refs`. Tooltip first line `File Shake — {E} edited, {R} referenced`, then one line per edited row (`name — badge`).

### 7.6 `core/protocol.ts`, `webviewHtml.ts` (shared by host and webview)
```ts
export const PROTOCOL_VERSION = 1;
export type HostMessage = { type: 'snapshot'; snapshot: Snapshot };
export type WebviewMessage = { type: 'ready' } | { type: 'open'; id: string } | { type: 'error'; message: string };
export function parseHostMessage(raw: unknown): HostMessage | null;      // deep-validates; any malformed field -> null; rows.length <= 500; never throws
export function parseWebviewMessage(raw: unknown): WebviewMessage | null; // 'error' message truncated to 500 chars
export function buildWebviewHtml(p: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; title: string }): string;
export function makeNonce(randomBytes: (n: number) => Uint8Array): string;   // 16 bytes -> 32 hex chars
```
Validation: `ViewRow` fields type-checked (strings are strings, `role`/`phase` enums, `source` enum|null, `intensity` and `shake.*` finite numbers, `intensity` in [0,1], `folderPath` string[]); `colors.*` must match the colour regex or ''. The host **never trusts `open.id` as a URI**: it looks the id up in the last snapshot's rows and opens that row's `uri` only.
`buildWebviewHtml` output (exact CSP): `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">`, `<meta charset="UTF-8">`, viewport meta, `<link rel="stylesheet" href="${styleUri}">`, `<div id="app"></div>`, `<script nonce="${nonce}" src="${scriptUri}"></script>`. No inline script/style/handlers, no remote URL, no `unsafe-*`. `title`/URIs HTML-attribute-escaped.

## 8. Reference detection (`core/references/**`, pure; async only for the injected fs)

```ts
export type LanguageKey = 'ts'|'js'|'python'|'go'|'java'|'kotlin'|'c'|'cpp'|'rust'|'ruby'|'php'|'css'|'scss'|'less'|'html'|'markdown';
export function detectLanguage(languageId: string, filePath: string): LanguageKey | undefined;  // languageId first (typescript[react]->ts, javascript[react]->js, python, go, java, kotlin, c, cpp, rust, ruby, php, css, scss, less, html, markdown), else by extension: .ts .tsx .mts .cts; .js .jsx .mjs .cjs; .py .pyi; .go; .java; .kt .kts; .c .h; .cc .cpp .cxx .hpp .hh .hxx; .rs; .rb; .php; .css; .scss; .less; .html .htm; .md .markdown
export interface ImportBinding { local: string; imported: string }   // imported: name | 'default' | '*'; local may be dotted (python "a.b.c")
export type ImportKind = 'import'|'export-from'|'require'|'dynamic'|'include'|'use'|'mod'|'link'|'style-import'|'markdown-link';
export interface ImportStatement { specifier: string; kind: ImportKind; line: number; endLine: number /* 1-based, inclusive */; bindings: ImportBinding[]; typeOnly: boolean; relativeLevel: number /* python leading dots, else 0 */; angle: boolean /* C <...> */ ; isStatic: boolean /* java static import */ }
export interface ScanResult { masked: string; strings: ReadonlyMap<number, string> }   // see below
export function scanCode(lang: LanguageKey, text: string): ScanResult;
export function parseImports(lang: LanguageKey, text: string): ImportStatement[];       // sync, total, linear-time, <= MAX_STATEMENTS
export function countUsages(masked: string, bindings: readonly ImportBinding[], excludeLines: ReadonlySet<number>): number;
export interface ProbeFs { isFile(p: FileKey): Promise<boolean>; listDir(p: FileKey): Promise<string[]> /* names, [] if missing */; readText(p: FileKey, maxBytes: number): Promise<string | undefined> }
export interface ProjectInfo { roots: FileKey[]; tsconfig?: { dir: FileKey; baseUrl?: FileKey; paths: Record<string, string[]> }; goModule?: { dir: FileKey; modulePath: string }; psr4?: Record<string, FileKey[]> }
export function loadProjectInfo(fs: ProbeFs, from: FileKey, roots: readonly FileKey[]): Promise<ProjectInfo>;
export interface ResolvedTarget { key: FileKey; bindings: readonly ImportBinding[] }   // python `from pkg import a, b` can yield several targets, each with its own bindings; other languages: one target with all `stmt.bindings`
export interface ResolveContext { fs: ProbeFs; project: ProjectInfo; isExcluded(key: FileKey): boolean; budget: { probes: number }; memo: Map<string, boolean> }
export function resolveImport(stmt: ImportStatement, from: FileKey, lang: LanguageKey, ctx: ResolveContext): Promise<ResolvedTarget[]>;   // resolver.ts
export interface ReferenceTarget { key: FileKey; count: number; statements: number; usages: number; lines: number[]; specifiers: string[] }
export interface ReferenceResult { source: FileKey; language: LanguageKey | undefined; targets: ReferenceTarget[]; truncated: boolean; unresolved: number; skipped?: 'unsupported-language'|'too-large'|'binary'|'unreadable'|'excluded'; parseMs: number }
export interface AnalyzeInput { path: FileKey; languageId: string; text: string; fs: ProbeFs; project: ProjectInfo; isExcluded(key: FileKey): boolean; now?: () => number; maxFileSizeKb?: number }
export function analyzeReferences(i: AnalyzeInput): Promise<ReferenceResult>;   // never rejects; catches fs errors -> counted as unresolved
```
**8.1 `scanCode`** returns `masked` = same length as `text`, newlines preserved, with comments replaced by spaces and **string contents** replaced by spaces (opening/closing quote characters kept), plus `strings` mapping the offset of each opening quote to the raw string contents. Parsers run regexes on `masked` and read specifiers via `strings.get(offsetOfQuote)`; therefore imports inside comments or string literals are never matched. Per family: **C-like** (ts, js, java, kotlin, c, cpp, go, rust, php, css, scss, less): `//` (not in css; css has only `/* */`), `/* */` (Rust nests), `'`, `"`, JS/TS template literals (text blanked, `${ ... }` bodies stay code, nested), Go raw strings `` ` ``, Java/Kotlin `"""` text blocks, Rust raw strings `r#"..."#` and lifetimes (`'a`) not treated as char literals; JS regex literals are recognised only after `( , = : [ ! & | ? { } ;` or line start (best effort); PHP is scanned only inside `<?php`/`<?=` ... `?>` (rest blanked), `#` is a comment in PHP. **Python/Ruby**: `#` comments, strings with prefixes (`r b f u` combos), triple quotes, Ruby `=begin/=end`. **HTML**: only `<!-- -->` blanked (attribute values are needed). **Markdown**: fenced code blocks, inline code and `<!-- -->` blanked; link syntax kept. Unterminated constructs blank to EOF; never throw.
**8.2 `countUsages`**: for each distinct `local`, count whole-identifier occurrences in `masked` where the previous char is not `[A-Za-z0-9_$]`, the next char is not `[A-Za-z0-9_$]`, and the previous char is not a single `.` (a `.` that is the end of `...` is allowed; `?.` before is allowed), and the occurrence's line is not in `excludeLines` (lines of the import statements themselves). Dotted locals (`a.b.c`) match as a literal sequence with the same boundary rules. **Not modelled (documented, Tester asserts current behaviour):** shadowing/redeclaration, object-literal keys (`{ foo: 1 }` counts), f-string expressions (Python strings are blanked), JSX text.
**8.3 Count per target** = `statements` (each resolved ImportStatement pointing at it = 1, any kind, including `import type`, side-effect imports, dynamic imports, `export … from`) + `usages` (Σ over its **distinct** binding locals of `countUsages`). Languages with no bindings (C/C++, CSS family, HTML, Ruby, markdown, `mod`) count statements only. Targets: drop self-reference, drop anything with a `node_modules` path segment, drop `isExcluded`, drop non-existent; sort by `count` desc then `key` asc; keep `MAX_REFS_PER_SOURCE`, set `truncated`.
**8.4 Statement forms to recognise (positive) — everything else must not match:**


| Lang | Forms |
|---|---|
| ts/js | `import D from 'm'`; `import D, { a, b as c, type T } from 'm'`; `import * as ns from 'm'`; `import 'm'`; `import type { T } from 'm'` (typeOnly); `import x = require('m')`; `export { a } from 'm'`; `export * from 'm'`; `export * as ns from 'm'`; `export type { T } from 'm'`; `require('m')` anywhere (bindings only for `const\|let\|var X = require('m')` / `const { a, b: c } = require('m')`); `import('m')` with a literal (no `${`). Multi-line braces supported (`endLine`). Bindings: default->`D`/`default`, `b as c` -> local `c` imported `b`, ns -> `*`. |
| python | `import a.b.c` (local `a.b.c`); `import a.b as x`; `import a, b`; `from a.b import c, d as e`; `from . import x`; `from ..pkg import y`; parenthesised/backslash-continued lists; `from m import *` (no bindings). `relativeLevel` = leading dots. |
| go | `import "p"`, `import alias "p"`, `import _ "p"`, `import . "p"`, grouped `import ( ... )`. Local = alias, else last path segment (skip trailing `vN`); `_` and `.` -> no binding. |
| java/kotlin | `import a.b.C;` `import static a.b.C.m;` `import a.b.*;` (wildcard: parsed, never resolves) `import a.b.C as D` (kotlin). Local = simple name (or `as` alias; static: member name). `package x.y;` is read for source-root derivation. |
| c/cpp | `#include "x.h"` and `#include <x.h>` (`angle`), `# include` spacing, comments between tokens; `#import` ignored. No bindings. |
| rust | `mod name;` (not `mod name {`), `use crate::a::b::{C, D as E};`, `use self::`/`super::`, `pub use`. Local = last segment / alias / each brace item. |
| ruby | `require_relative 'x'`, `require 'x'`, `load 'x.rb'`, `autoload :S, 'x'`. No bindings. |
| php | `require\|require_once\|include\|include_once` + string literal or `__DIR__ . '/x'` / `dirname(__FILE__) . '/x'`; `use A\B\C;`, `use A\B\C as D;`, `use A\B\{C, D};` (not `use function/const`). Local = last segment / alias. |
| css/scss/less | `@import "x"`, `@import url("x")`, `@import url(x)`, `@import "a", "b";`, less `@import (css) "x"`, scss `@use "x" [as y]`, `@forward "x"`. Skip `http(s):`, `//`, `~pkg`, `pkg:`, `sass:*`. No bindings. |
| html | `src=`/`href=` on any tag (quoted/unquoted); skip scheme URLs (`^[a-z][a-z0-9+.-]*:`), `//…`, `#…`, `data:`, `mailto:`; strip `?query` / `#hash`. Each tag attribute = 1 statement. |
| markdown | `[t](path)`, `![t](path)`, `[ref]: path`; skip schemes, `#anchor`; strip `<>`, `?query`, `#hash`. Optional: if skipped, record in Deviations. |
Specifiers longer than 512 chars or containing NUL/newline are ignored.
**8.5 Resolver** (`resolveImport`, usually 0..1 targets; every probe goes through a memo `Map` and decrements `MAX_PROBES`; at budget exhaustion remaining statements stay unresolved). All paths pass through `normalizePath` first (Windows `\` in specifiers handled).
- **ts/js**: `./`,`../`, `.`, `..` -> relative to `dirname(from)`. `/x` -> relative to each workspace root. Bare -> try `tsconfig.paths` (keys with at most one `*`, longest literal prefix wins, targets relative to `baseUrl` else tsconfig dir, tried in order), then `baseUrl + spec`; otherwise **unresolved (never node_modules, no package `exports`/workspaces)**. Candidates per base, first existing wins: `base` (if it already has a known ext and is a file) -> `base + ext` -> `base/index + ext`. Ext order for ts `from`: `.ts .tsx .d.ts .js .jsx .mts .cts .mjs .cjs .json .vue .svelte`; for js `from`: `.js .jsx .mjs .cjs .ts .tsx .json`. If the spec ends in `.js/.jsx/.mjs/.cjs`, also try the same stem with `.ts/.tsx/.mts/.cts`. tsconfig = nearest `tsconfig.json` then `jsconfig.json` walking up from `dirname(from)`; relative `extends` followed up to 3 levels (child overrides); `include`/`references` ignored.
- **python**: absolute `a.b.c` tried against search roots = every ancestor dir of `from` up to its workspace root, plus `<root>/src`: `<r>/a/b/c.py`, `<r>/a/b/c/__init__.py`. Relative (`relativeLevel` n): base = `dirname(from)` up `n-1` levels. For `from X import n`: if `X/n.py` or `X/n/__init__.py` exists it is the target for binding `n`, else the module `X` is.
- **go**: needs `goModule` (nearest `go.mod`, `module` line). Import path `M` or `M/rest` -> dir `goModule.dir/rest`; target = first non-`_test.go` `.go` file in that dir (prefer `<lastSegment>.go`, else alphabetical). Anything else -> unresolved.
- **java/kotlin**: source roots = dir of `from` with its `package` path stripped, plus per workspace root `.`, `src`, `src/main/java`, `src/main/kotlin`, `app/src/main/java`, `app/src/main/kotlin`, `src/test/java`, `src/test/kotlin`. Try the qualified name as path `a/b/C.java|.kt`, then drop trailing segments one at a time (nested classes / static members) down to 1 segment. Wildcards never resolve.
- **c/cpp**: quote form: `dirname(from)`, then each root, `<root>/include`, `<root>/src`. Angle form: only `<root>/include`, `<root>/src` (system headers stay unresolved).
- **rust**: `mod x;` -> `<d>/x.rs` or `<d>/x/mod.rs` with `d = dirname(from)` if `from` is `mod.rs\|lib.rs\|main.rs`, else `dirname(from)/<stem(from)>`. `use crate::a::b::C`: crate src = nearest ancestor dir named `src`; try `src/a/b.rs`, `src/a/b/mod.rs`, then shorter prefixes `src/a.rs`, `src/a/mod.rs`. `self::` / `super::` analogous from the current / parent module dir. Other `use` (std, external crates) unresolved.
- **ruby**: `require_relative` -> relative to `dirname(from)` + `.rb`; `require`/`load` -> `<root>/lib/x.rb`, `<root>/x.rb`, `<root>/app/x.rb`.
- **php**: include of a path expression -> relative to `dirname(from)` (also `__DIR__`); `use` FQN -> `composer.json` `autoload.psr-4` prefixes (+ `autoload-dev`) when present, else suffixes of the FQN as path under `<root>`, `<root>/src`, `<root>/app`, `<root>/lib` (`.php`), longest first, <= 16 probes.
- **css/scss/less**: relative to `dirname(from)`; scss tries `x`, `x.scss`, `_x.scss`, `x.css`, `x/_index.scss`, `x/index.scss`; less/css add `.less` / `.css`.
- **html/markdown**: relative to `dirname(from)`; leading `/` -> workspace root(s); a directory (trailing `/`) -> `index.html`; markdown extensionless -> try `+ .md`.
**8.6 Known limits (README + Tester asserts current behaviour):** regex/token based, not semantic; Go/Rust/Java implicit same-package references not found; Go and Java import maps to **one** file per import; bundler aliases (webpack/vite) and package `exports` ignored; Python namespace packages without `__init__.py` partially; dynamic `require(variable)` ignored; no Vue/Svelte/Astro; generated/minified files are excluded by default globs.
**8.7 Performance contract (core, in-memory fs):** `parseImports` + `scanCode` + `countUsages` for a 5,000-line (~200 KB) TS file: target <= 150 ms, **test asserts <= 400 ms**. A 500 KB single-line pathological file (e.g. `"a".repeat` / thousands of `(`): <= 1000 ms (no catastrophic regex; all patterns linear). `analyzeReferences` returns `skipped:'too-large'` if `text.length > maxFileSizeKb*1024` (default 512) and `'binary'` if the first 8,000 chars contain `\u0000`, before any scanning.

## 9. Source detection (you vs external) — algorithm and honest reliability

Pipeline (`vscode/editWatcher.ts`, using §7.3 classifiers; every decision, including ignores, is appended to `EventLog`):
1. **Documents**: `onDidChangeTextDocument(e)`: skip if `config.enable` false (reason `disabled`); skip scheme !== `file` (`scheme`); skip excluded path (`excluded`). Build `DocChangeContext` (`isSaving` from a `Set` filled by `onWillSaveTextDocument`, cleared by `onDidSaveTextDocument` and by a 5 s safety timeout; `isActiveEditorDoc = e.document === window.activeTextEditor?.document`; `windowFocused = window.state.focused`). Weight: `you` -> `typingWeight(contentChanges.map(c => ({ inserted: c.text.length, deleted: c.rangeLength })))`; `external` -> `K.EXTERNAL_EVENT_WEIGHT` (reload size is meaningless). If `detectExternalEdits` is false, `external` decisions become `ignore / external-detection-off`.
2. **Disk**: one `RelativePattern(folder, '**/*')` watcher per workspace folder (recreated on `onDidChangeWorkspaceFolders`): `onDidChange`/`onDidCreate` -> scheme file, not excluded, `BurstGuard.accept` (reason `burst`), `classifyWatcherEvent({ msSinceOwnSave })` where `lastSaveAt` is set in `onDidSaveTextDocument` (bounded Map, 200 entries). `onDidDelete` -> `tracker.forgetUnder(key)`, drop reference results mentioning it. `onDidRenameFiles` -> `tracker.renameUnder`, invalidate references; when tracked state moved, the rename's own file-system echo (create/change of the new path, or of anything under a renamed folder) within `SELF_SAVE_WINDOW_MS` is `ignore / self-save`, so renaming a file you are typing in keeps it `you`. Directory create events are ignored by `stat` check (`FileType.Directory`); size is not checked for tracking (only for parsing).
3. Open and clean documents reloaded from disk produce both a watcher event and a document event; the tracker's `EXTERNAL_DEDUPE_MS` collapses them (reason `dedupe`). Both paths pass `BurstGuard`: an `external` document event (reload or background edit) is `ignore / burst` while a flood is in progress, so a checkout that rewrites files whose documents are open is suppressed like one that rewrites closed files. `you` events are never burst-limited.

Reliability (README "How it works" must say this plainly):
- **`you` is reliable** for ordinary typing, paste, undo/redo, multi-cursor in the focused editor. **False `you`**: another extension inserting into the focused editor (Copilot/inline completions, snippets), and any agent that applies a `WorkspaceEdit` to the active document while the window is focused (the document is dirty and focused, indistinguishable from typing).
- **`external` is "changed without keystrokes in the focused editor"**: it cannot name the writer. Claude Code (CLI/IDE) normally writes to disk -> watcher + (if open and clean) reload event: classified correctly. The same label is given to git checkout/pull, formatters, codegen, build tools, `File: Revert`, other extensions, and sync clients. Bulk operations (> 30 files/s) are suppressed by `BurstGuard`.
- Misses: writes to paths excluded by `files.watcherExclude`/our `excludeGlobs`; external write within 2 s after the user's own save of the same file (treated as self-save); external write to a dirty open document is still `external` (watcher) but the editor does not reload it.
- Latency: watcher events arrive ~50-500 ms after the write, so the first shake lags the write slightly.
- Window unfocused + programmatic edits -> `external`. Notebook cells, `untitled:`, `git:`, `output:` -> ignored.
- Merely opening/focusing a file never counts as activity.

## 10. VS Code adapters (`src/vscode/**`) — behaviour contract

- `uriKey.ts`: `fileKeyFromUri(uri): FileKey | undefined` (scheme `file` only; `normalizePath(uri.fsPath)`); `uriFromKey(key): vscode.Uri` (`Uri.file`); `getRoots(): WorkspaceRoot[]` from `workspace.workspaceFolders ?? []`.
- `config.ts`: `readConfig(): FileShakeConfig` (assemble raw record from `getConfiguration('fileShake')` incl. `colors.edited`->`editedColor`, `colors.referenced`->`referencedColor`, then `sanitizeConfig`); `onDidChangeConfig(cb)` filters `affectsConfiguration('fileShake')`; `toggleEnabled()` writes `fileShake.enable` to the scope where it is currently defined (`inspect()`: workspaceFolder > workspace > global), default Global.
- `referenceService.ts`: `class ReferenceService implements Disposable { constructor(deps: { scheduler: Scheduler; clock: Clock; getConfig(): FileShakeConfig; getRoots(): WorkspaceRoot[]; log(msg: string): void }); request(key: FileKey): void; get(key): ReferenceResult | undefined; invalidate(prefix: FileKey): void; invalidateAll(): void; whenIdle(): Promise<void>; readonly onDidChange: Event<FileKey>; results(): ReadonlyMap<FileKey, ReferenceResult>; dispose() }`. `request` debounces `REF_DEBOUNCE_MS` per key; only the latest request per key runs (generation counter); at most one analysis in flight globally (queue). Text source: open document `getText()` (version key `doc:<version>`), else `workspace.fs.stat` (size cap check first) + `readFile` (version key `disk:<mtime>:<size>`); unchanged version key => reuse cached result. `ProbeFs` over `workspace.fs` (`stat` with `(type & FileType.File) !== 0` so symlinked files count; `readDirectory`; `readFile` capped). Project info cached per directory; cleared when a watcher event names `tsconfig.json`, `jsconfig.json`, `go.mod`, `composer.json`. LRU of 50 results. No sync fs, never awaited on the activation path.
- `controller.ts`: `class ShakeController implements Disposable` owns `ActivityTracker`, `ReferenceService`, `EventLog`, `BurstGuard`, last rows/decorations/snapshot, `seq`. `onActivity(key, source, weight)` -> `tracker.record`, `references.request(key)` (only if recorded), `schedule tick`. **Tick**: while any tracked file is `active`, or idle-pending-removal (`!showWhenIdle`), a `scheduler.setTimeout(TICK_MS)` chain recomputes: `tracker.snapshot()` -> `buildRows` -> decorations diff (`changedKeys` -> `provider.update`) -> status bar -> view `push` (skipped when view hidden; stored dirty and sent on visible). The chain stops when nothing is pending (**zero timers when idle**). `refresh()` recomputes immediately (config change, reference result arrival, clear). Emits `onDidUpdate`. `getDebugInfo(): DebugInfo`.
- `decorationProvider.ts`: `class ShakeDecorationProvider implements FileDecorationProvider, Disposable { update(next: Map<FileKey, DecorationSpec>): void; provideFileDecoration(uri): FileDecoration | undefined; onDidChangeFileDecorations }`. `update` stores `next`, fires `Uri[]` for `changedKeys` (chunked <= 250). Maps spec -> `new FileDecoration(spec.badge, spec.tooltip, new ThemeColor(spec.colorId))` with `propagate = spec.propagate`.
- `shakeViewProvider.ts`: `resolveWebviewView`: `options = { enableScripts: true, localResourceRoots: [dist, media] }`; `html = buildWebviewHtml({... nonce: makeNonce(crypto.randomBytes) ...})`; on `onDidReceiveMessage` -> `parseWebviewMessage`; `ready` -> send latest snapshot; `open` -> look up id in last snapshot -> `window.showTextDocument(uri, { preview: true })`, catching errors; `error` -> log. `onDidChangeVisibility` visible -> resend latest snapshot. `push(snapshot)`: store; `postMessage` only if visible. `onDidDispose` clears the reference. Registered with `retainContextWhenHidden: false`.
- `statusBar.ts`: `createStatusBarItem(StatusBarAlignment.Left, 0)`, `command: 'fileShake.focusView'`, text/tooltip from `buildStatus` (tooltip as plain text), shown unless `showStatusBar` false.
- Commands (`extension.ts`): `fileShake.toggle` (toggleEnabled), `fileShake.clear` (tracker.clear + `references.invalidateAll` + refresh), `fileShake.focusView` (`executeCommand('fileShake.view.focus')`), `fileShake.showDebugInfo` (OutputChannel `File Shake`: `clear()`, JSON of `DebugInfo { extensionVersion, vscodeVersion, config, roots, enabled, viewVisible, seq, tracked, rows, references: [{source, targets, unresolved, truncated, skipped, parseMs}], recentEvents }`, `show(true)`).
- Disabled (`enable=false`): listeners stay registered but return early (reason `disabled`); tracker/reference caches cleared; decorations cleared; view shows the off state; status shows off.
- `extension.ts`: `activate(context): FileShakeApi` creates everything, pushes **every** disposable to `context.subscriptions` (watchers, listeners, controller timers, status item, provider, output channel); `deactivate()` is a no-op. Activation does no file IO and no timers.
- **Test seam** (only when `process.env.FILE_SHAKE_TEST === '1'`): controller uses `ManualClock` + `ManualScheduler`, `FileShakeApi.testing` is defined, and `window.state.focused` is replaced by an overridable value (default `true`).
```ts
export interface FileShakeApi {
  readonly apiVersion: 1;
  getRows(): readonly ViewRow[]; getTracked(): readonly TrackedFile[]; getSnapshot(): Snapshot;
  getDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;   // calls provider synchronously
  getStatusText(): string; getEventLog(): readonly LogEntry[]; isEnabled(): boolean;
  readonly onDidUpdate: vscode.Event<void>;         // after every model rebuild
  whenReferencesIdle(): Promise<void>;
  readonly testing?: { advance(ms: number): void; overrideFocus(v: boolean | undefined): void };  // advance = clock + scheduler (ticks, debounces); then call refresh
}
```

## 11. Webview contract (`src/webview/app.ts`, `main.ts`, `media/webview.css`)

```ts
export interface PersistedState { collapsed: string[] }     // folder ids the user collapsed
export interface HostApi { postMessage(m: WebviewMessage): void; getState(): PersistedState | undefined; setState(s: PersistedState): void }
export interface AppEnv { reducedMotion(): boolean; onReducedMotionChange(cb: () => void): () => void; setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void }
export interface App { handleMessage(raw: unknown): void; dispose(): void; readonly lastSeq: number }
export function mountApp(root: HTMLElement, host: HostApi, env?: Partial<AppEnv>): App;   // env defaults from window (matchMedia('(prefers-reduced-motion: reduce)'))
```
`mountApp` posts `{type:'ready'}`, renders the empty state, delegates `click`/`keydown` on `root`. `handleMessage` -> `parseHostMessage` (null => ignore, no throw); a `snapshot` with `seq < lastSeq` is ignored. `main.ts` = `acquireVsCodeApi()` + `mountApp(#app)` + `window.addEventListener('message', e => app.handleMessage(e.data))`.
**DOM contract (Tester selects on these):**
```
#app[data-motion="on|off"][data-state="empty|disabled|rows"]
  .fs-empty                                  # text only (empty/disabled hint)
  ul.fs-tree[role=tree]
    li.fs-folder[data-folder-id][role=treeitem][aria-expanded]
       button.fs-folder-toggle > span.fs-chevron + span.fs-folder-label + span.fs-folder-count
       ul.fs-children[role=group]
    li.fs-row.fs-row--edited|fs-row--referenced[.is-shaking][.is-idle][.is-leaving]
       [data-id][data-role][data-phase][data-source=you|external][role=treeitem][tabindex=0][aria-label]
       span.fs-name + span.fs-dir + span.fs-badge + span.fs-meter > i
```
Rules: all text via `textContent`/`setAttribute` of known attributes (hostile names like `<img onerror=…>`, quotes, unicode render as text; **no `innerHTML`, no `setAttribute('style')`**). Per row set via `el.style.setProperty`: `--fs-amp` (`2.25px`), `--fs-dur` (`110ms`), `--fs-rot` (`0.7deg`), `--fs-level` (`0.5`). `data-motion="off"` iff `snapshot.animate === false` or `env.reducedMotion()`; then **no row has `.is-shaking`** (colour, badge, meter still shown). `.is-shaking` iff motion on && `phase==='active'` && `intensity>0`. `.is-idle` iff `phase==='idle'`. Rows keyed by `id` and updated in place (no full re-render per snapshot; nodes persist so CSS animations do not restart). A row missing from the next snapshot gets `.is-leaving` and is removed after `LEAVE_MS` via `env.setTimeout` (re-appearing before then revives it). Folder collapsing: click/Enter on toggle flips `aria-expanded`, hides `.fs-children`, persists via `host.setState`; **a folder is auto-expanded (removed from `collapsed`) when a new file id first appears beneath it**; collapsed folders still show `.fs-folder-count` and a role dot. Click/Enter/Space on `.fs-row` posts `{type:'open', id}`. Colours: root `style.setProperty('--fs-edited-override', c)` only when `snapshot.colors.edited !== ''` (else `removeProperty`); same for referenced.
**CSS contract:** theme colours `var(--fs-edited-override, var(--vscode-fileShake-editedForeground, #3fb950))` and `…referenced… #e3b341`; fonts/background from `--vscode-*`. `@keyframes fs-shake` uses `translate(calc(var(--fs-amp) * k), calc(var(--fs-amp) * k2)) rotate(calc(var(--fs-rot) * k3))` over 5 steps; `.fs-row.is-shaking { animation: fs-shake var(--fs-dur) linear infinite }`; `@media (prefers-reduced-motion: reduce)` and `#app[data-motion="off"]` both force `animation: none !important`. `.is-idle { opacity: .55; transition: opacity .6s }`, `.is-leaving { opacity: 0; transition: opacity 400ms }`. `.fs-meter > i { width: calc(var(--fs-level) * 100%) }` is the non-motion intensity cue. `body.vscode-high-contrast .fs-row, body.vscode-high-contrast-light .fs-row { outline: 1px solid var(--vscode-contrastBorder) }`. Light/dark/HC: row colour is applied to name + 3 px left border + badge border (never colour alone: badge text and meter carry meaning).
**Contributed colours (package.json):** `fileShake.editedForeground` {dark `#3fb950`, light `#1a7f37`, highContrast `#3fb950`, highContrastLight `#116329`}; `fileShake.referencedForeground` {dark `#e3b341`, light `#9a6700`, highContrast `#e3b341`, highContrastLight `#7d4e00`}.

## 12. Edge cases (Builder handles, Tester asserts; unit `U`, integration `I`, webview `W`)

| Case | Required behaviour |
|---|---|
| No folder open (U,I) | Typing is tracked; roots `[]`; rows grouped under `(outside workspace)`; no watchers; commands work |
| Multi-root (U,I) | One watcher per folder; display `folderPath[0]` = root name; same file name in two roots stays distinct (`id` = full key); nested roots -> longest wins |
| File outside workspace (U,I) | Tracked/decorated; exclude matching uses absolute path sans leading `/`; references resolve with `roots = [dirname(file)]` |
| Huge file (> `maxFileSizeKb`) (U) | Green tracking works; `skipped:'too-large'`; no read of full file in adapter (`stat` first) |
| Binary file (U) | `skipped:'binary'`; tracked green unless excluded |
| Untitled / non-`file` scheme (U,I) | Ignored (`scheme`) |
| Rename / delete mid-edit (U,I) | `forget`/`renameUnder`; reference targets pointing at it dropped; no exception; pending analysis for a deleted source is discarded |
| Circular imports / self reference (U) | A->B and B->A both resolve independently; self target dropped; no recursion (analysis is single-file, non-transitive) |
| `node_modules` / bare packages (U) | Never targets, even via symlink-looking relative paths containing the segment |
| Symlinks (U,I) | `isFile` true for symlinked files; no realpath; no recursion into symlinked dirs |
| Windows paths (U) | `C:\a\b.ts`, mixed separators, drive-letter case, UNC, `\` in specifiers all normalise to the same `FileKey` |
| Case-insensitive FS (U) | Keys compared exactly; only the drive letter is lower-cased (documented) |
| Same file edited by you and external (U) | `source` follows last accepted event |
| Both edited and referenced (U) | Green wins: one row, role `edited` |
| Undo to clean state (U) | Classified `you` (undo-redo), not reload |
| Save / format-on-save / autosave (U,I) | No new activity from saving itself (`saving`, `self-save`) |
| Rapid 200 edits (U) | Tracker stays within 20 ms total; bounded memory (`MAX_EVENTS_PER_FILE`) |
| 100 files touched in 1 s (U) | `BurstGuard` suppresses; no flood of decorations |
| Config changes live (U,I) | Options re-applied without restart; `enable=false` clears state; invalid values sanitised |
| View hidden / re-shown / disposed (I,W) | No `postMessage` while hidden; snapshot resent on show; no throw after dispose |
| Malformed messages (U,W) | Ignored both directions; `open` with unknown id is a no-op |
| Hostile names `<img onerror>`, quotes, RTL, emoji (W) | Rendered as text only; no element injected; selector-escaped lookups |
| Reduced motion / animation off (W) | `data-motion="off"`, zero `.is-shaking`, colour+badge+meter present |
| Out-of-order snapshot (W) | `seq < lastSeq` ignored |
| Deactivate / dispose twice (I) | No leaks, no timers left (`ManualScheduler.pending === 0` after dispose) |

## 13. Build plan, manifest, scripts

**Milestones (do not advance on red `npm run build` / `lint` / `test:unit`):** M0 scaffold + `npm install` (exact versions §3) -> M1 `constants, types, pathUtils, clock, config, intensity, activityTracker, sourceClassifier, burstGuard, eventLog, glob` -> M2 references (`scan, parsers, usage, projectInfo, resolver, index`; TS/JS + Python + C first, then the rest; markdown last) -> M3 `viewModel, tree, decorations, statusText, protocol, webviewHtml` -> M4 webview (`app.ts`, `main.ts`, `webview.css`) verified with the `browser-automation` skill on a mock-data HTML page (screenshot: green and yellow rows visibly moving, light + dark + reduced motion) -> M5 adapters + `extension.ts` -> M6 icon script, README (must state §2 items 1-6 and §9 reliability), CHANGELOG, LICENSE (MIT, "Copyright (c) 2026 File Shake contributors"), `.vscodeignore` -> M7 `npm run package`, inspect `.vsix` (`npx vsce ls --no-dependencies`; expect only `package.json, README.md, CHANGELOG.md, LICENSE.txt, dist/extension.js, dist/webview.js, media/icon.png, media/webview.css`; size < 150 KB; no `.map`, `src`, `test`, `node_modules`), installability **is** verifiable even though no `code` is on PATH: the installed app ships a CLI **[spike: installed a .vsix this way]**: `env -u ELECTRON_RUN_AS_NODE -u <every VSCODE_* var> "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --user-data-dir <tmp>/ud --extensions-dir <tmp>/ext --install-extension file-shake-0.1.0.vsix` prints `successfully installed`, and the same command with `--list-extensions --show-versions` must print `file-shake.file-shake@0.1.0` (isolated dirs: the user's own VS Code is untouched; the env scrub is required for the same reason as in the integration harness).

**npm scripts:**
```json
"build": "node esbuild.mjs", "build:prod": "node esbuild.mjs --production", "watch": "node esbuild.mjs --watch", "build:test": "node esbuild.mjs --tests",
"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p src/webview/tsconfig.json --noEmit && tsc -p test/tsconfig.json --noEmit",
"lint": "eslint . && npm run typecheck",
"test:unit": "node --import tsx --test \"test/unit/**/*.test.ts\" \"test/webview/**/*.test.ts\"",
"test:integration": "npm run build && npm run build:test && node --import tsx test/integration/runTest.ts",
"test": "npm run test:unit && npm run test:integration",
"vscode:prepublish": "node esbuild.mjs --production",
"package": "vsce package --no-dependencies --allow-missing-repository"
```
**Integration harness (Tester owns `test/integration/**`) — verified in a spike that launched real VS Code 1.129.1 and passed (extension activated, Explorer webview view resolved via `fileShake.view.focus`, nonce'd script ran and posted `ready`, `--vscode-fileShake-editedForeground` was readable inside the webview as `#3fb950`, decoration provider callable, `window.state.focused === true`):**
- `runTest.ts` (run with `node --import tsx`) calls `runTests({ vscodeExecutablePath | version, extensionDevelopmentPath: <repo root>, extensionTestsPath: <root>/out/integration/index.js, extensionTestsEnv: { FILE_SHAKE_TEST: '1' }, launchArgs: [<temp workspace copy of test/fixtures/workspace>, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir=<tmp>/ud', '--extensions-dir=<tmp>/ext'] })`. Use short temp paths (macOS socket path limit).
- **Environment trap:** these agent sessions run inside a VS Code extension host, so the shell has `ELECTRON_RUN_AS_NODE=1` and `VSCODE_*` variables; inherited, they make the launched Electron behave as plain Node (`Cannot find module '<workspace>'`). `runTest.ts` must first delete `ELECTRON_RUN_AS_NODE` and every `VSCODE_*` key from `process.env`. Therefore the executable override must **not** be named `VSCODE_*`: use `FS_VSCODE_EXE`.
- **Do not download VS Code here.** Measured ~65 KB/s to the CDN: stable is 334 MB (~85 min), 1.85.0 is 124 MB (~30 min). A local install exists: `FS_VSCODE_EXE="/Applications/Visual Studio Code.app/Contents/MacOS/Electron"` (1.129.1) -> `vscodeExecutablePath`. Without `FS_VSCODE_EXE`, fall back to `version: process.env.VSCODE_TEST_VERSION ?? 'stable'` (cached in `.vscode-test/`, git/vscodeignored). Cold `npm install` also took ~7 min here; run it once, in the background.
- `index.ts` exports `run()`, builds `new Mocha({ ui: 'tdd', timeout: 60000 })`, `addFile`s every `out/integration/suite/*.test.js` (found with `fs.readdirSync`) and rejects on failures. Tests are bundled by `esbuild.mjs --tests` with `external: ['vscode','mocha']` (bundling mocha emits warnings). Extension id: `file-shake.file-shake`. Synchronise on `api.onDidUpdate` / `api.whenReferencesIdle()` / `api.testing.advance()`, never sleeps. A user's own VS Code may be running; the separate `--user-data-dir` makes that safe.
- If VS Code cannot launch, the Tester reports the suite as not run and what that leaves unverified.

**`package.json` skeleton (fields are mandatory unless noted):**
```jsonc
{ "name": "file-shake", "displayName": "File Shake", "version": "0.1.0", "publisher": "file-shake", /* placeholder: owner must replace before Marketplace publish */
  "description": "See which files are being edited, live: green for the file being changed, yellow for the files it references, shaking in proportion to activity.",
  "license": "MIT", "icon": "media/icon.png", "galleryBanner": { "color": "#0d1117", "theme": "dark" },
  "categories": ["Visualization", "Other"], "keywords": ["files","activity","explorer","imports","claude","ai","live"],
  "repository": { "type": "git", "url": "https://github.com/OWNER/file-shake.git" }, /* placeholder */
  "engines": { "vscode": "^1.85.0" }, "main": "./dist/extension.js", "extensionKind": ["workspace"],
  "activationEvents": ["onStartupFinished"],
  "capabilities": { "untrustedWorkspaces": { "supported": true }, "virtualWorkspaces": { "supported": "limited", "description": "File watching and import resolution need a real file system." } },
  "contributes": {
    "views": { "explorer": [ { "type": "webview", "id": "fileShake.view", "name": "File Shake", "contextualTitle": "File Shake" } ] },
    "commands": [ { "command": "fileShake.toggle", "title": "Toggle On/Off", "category": "File Shake" }, { "command": "fileShake.clear", "title": "Clear", "category": "File Shake" }, { "command": "fileShake.focusView", "title": "Focus View", "category": "File Shake" }, { "command": "fileShake.showDebugInfo", "title": "Show Debug Info", "category": "File Shake" } ],
    "menus": { "view/title": [ { "command": "fileShake.clear", "when": "view == fileShake.view", "group": "navigation" }, { "command": "fileShake.toggle", "when": "view == fileShake.view", "group": "navigation" } ] },
    "colors": [ /* §11 two entries */ ],
    "configuration": { "title": "File Shake", "properties": { /* below */ } } } }
```
Settings (`default` / constraints / scope `window` unless noted): `fileShake.enable` bool true; `fileShake.enableAnimation` bool true; `fileShake.idleTimeoutMs` number 2500 min 500 max 60000; `fileShake.windowMs` number 3000 min 500 max 30000; `fileShake.maxFiles` integer 40 min 5 max 200; `fileShake.excludeGlobs` array of string (default list in §7.4); `fileShake.colors.edited` string "" (pattern `^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})?$`); `fileShake.colors.referenced` same; `fileShake.sensitivity` number 1 min 0.25 max 4; `fileShake.showWhenIdle` bool false; `fileShake.decorateFolders` bool true; `fileShake.detectExternalEdits` bool true; `fileShake.maxFileSizeKb` integer 512 min 16 max 4096; `fileShake.showStatusBar` bool true. Every property has `markdownDescription` (colour settings state "webview only; Explorer colours: `workbench.colorCustomizations` keys `fileShake.editedForeground` / `fileShake.referencedForeground`").
`scripts/make-icon.mjs`: writes a valid 128x128 RGBA PNG with Node `zlib` + manual CRC32 (dark `#0d1117` rounded tile, one green and two yellow offset bars); the icon must be regenerated by `node scripts/make-icon.mjs`.

## 14. Test mapping (Tester) and acceptance checklist

Unit (`test/unit/**`, `node:test`, `ManualClock`, in-memory `ProbeFs` built from `Record<path, content>`): §6 tables row by row; tracker (window, idle boundary at exactly `idleTimeoutMs`, retain removal at `idle+retain`, dedupe, eviction, rename/forgetUnder, clock regression, `showWhenIdle`); classifier table (all 6 rows + watcher + order precedence); `BurstGuard`; `sanitizeConfig` fuzz (undefined/NaN/strings/negative/huge); `pathUtils` incl. Windows; `scanCode` (comments, strings, template `${}`, nested, regex literal, Python triple quotes, Rust raw strings/lifetimes, PHP blocks); one fixture per language with positives and negatives (comments, strings, type-only, aliases, bare packages unresolved); resolver per §8.5 incl. tsconfig `paths`, `extends`, `index.*`, `__init__.py`, SCSS partials, Go module, Java static/nested, missing targets, probe budget; counting worked examples below; `buildRows`/`tree`/`decorations`/`statusText`/`protocol` (malformed fuzz); performance (§8.7, tracker 200 events).
Counting worked examples: (1) `import { a, b as bee } from './util'; import * as p from 'node:path'; import './side'; const x = a() + a() + bee(); // a() ignored  const s = "a()";` -> targets `util`: statements 1 + usages 3 = **4**, `side`: **1**, `node:path` unresolved (`unresolved` = 1). (2) Python `import pkg.mod as m` + `m.f(); m.g()` + `from .util import h` + `h(); h()` -> `pkg/mod.py` count 1+2 = 3, `util.py` 1+2 = 3. (3) C `#include "a.h"` twice + `#include <stdio.h>` -> `a.h` count 2, stdio unresolved. (4) `import {A} from './m'; import type {B} from './m'; A; B; B` -> `m` = 2 statements + 3 usages = 5.
Webview (`test/webview/**`, jsdom, `env.setTimeout` stub): DOM contract §11, CSS vars exact strings (`--fs-amp: 2.25px` for intensity 0.5), reduced motion, hostile names, malformed messages, seq ordering, collapse/auto-expand, leaving/revive, no `style` attributes in markup (`querySelectorAll('[style]')` only from `setProperty` is allowed; `innerHTML` banned by lint), CSP string from `buildWebviewHtml` (no `unsafe-`, nonce present on the single script, no `http`).
Integration (`test/integration/suite/**`): extension activates on `onStartupFinished`; commands + `fileShake.view.focus` registered; view resolves and posts `ready`; editing the active document via `TextEditor.edit` -> row `edited/you`, `getDecoration` returns badge `●` + ThemeColor `fileShake.editedForeground`; fixture `a.ts` importing `b.ts` -> `b.ts` yellow with count; writing a file with `fs.writeFile` -> `external` row; settings change (`getConfiguration().update`) applies live; `enable=false` clears; no-workspace and multi-root variants (separate `runTests` launches); dispose leaves no pending timers.
**Acceptance ("done")** — all must hold: `npm run build`, `lint`, `test:unit` exit 0; `test:integration` exit 0 or Tester states exactly why it could not run; `npm run package` creates `file-shake-0.1.0.vsix` with the expected file list and < 150 KB, and the CLI install check (§13 M7) lists `file-shake.file-shake@0.1.0`; README states §2 limits; manifest has icon (128x128 verified from PNG header), MIT LICENSE, CHANGELOG, `.vscodeignore`, `galleryBanner`; no `any` in `src`, no `innerHTML`; strict CSP verified; every disposable registered; zero timers when idle; browser screenshot shows green + yellow rows shaking and static under reduced motion; QA_REPORT has no `open` severity-high bug; mutation check shows tests fail when a core function is broken.

## Deviations
_(Builder: append `- <what> — <why>` here.)_

- `.npmrc` added (`save-exact=true`, `fund=false`, `audit=false`) — keeps future `npm install <pkg>` exact like the pins and silences funding/audit noise; not shipped (`.vscodeignore` is deny-by-default).
- `esbuild.mjs --tests` skips `test/integration/runTest.ts` — it runs under `node --import tsx` and imports `@vscode/test-electron`; bundling it into `out/` is useless. Every other `test/integration/**/*.ts` is an entry point as specified.
- Reference types (`LanguageKey`, `ImportBinding`, `ImportKind`, `ImportStatement`, `ScanResult`, `ProbeFs`, `ProjectInfo`, `ResolvedTarget`, `ResolveContext`, `ReferenceTarget`, `ReferenceResult`, `AnalyzeInput`) live in `core/types.ts` (one home for shared types, avoids cycles with `viewModel.ts`) and are re-exported from `core/references/index.ts`. `detectLanguage`/`parseImports` live in `references/parsers/index.ts` and are re-exported from `references/index.ts`.
- `ResolveContext` gained an optional `packageName?: string` (Java/Kotlin: package of the analysed file, cached after the first read). Optional, so contexts built without it keep working.
- Ruby `require_relative` and PHP `__DIR__ . '...'` / `dirname(__FILE__) . '...'` includes set `ImportStatement.relativeLevel = 1` as a "relative to this file" marker (the contract only defines `relativeLevel` for Python); `kind` stays `'require'` / `'include'`.
- `StatusInput` gained an optional `showWhenIdle?: boolean` (default false) so the `(and not showWhenIdle)` rule of DESIGN 7.5 can be honoured; with the field absent, idle edited rows give the generic `$(pulse) File Shake` text.
- `COLOR_PATTERN` is defined in `core/constants.ts` (re-exported from `core/config.ts`) so `core/protocol.ts` (bundled into the webview) does not import `core/config.ts`.
- Native decoration tooltips for edited files carry no edit count (`File Shake: Edited by you (typing)`), because `changedKeys` compares specs and a per-keystroke counter would fire `onDidChangeFileDecorations` on every edit (DESIGN 1 forbids that). The webview tooltip (`ViewRow.tooltip`) keeps `· N edits`. Referenced decorations use `File Shake: ` + `ViewRow.tooltip`.
- `changedKeys` returns the keys sorted ascending (deterministic).
- `analyzeReferences` counts usages on a copy of the masked text in which the exact source span of each import statement is blanked (instead of passing whole lines as `excludeLines`), so `import {a} from 'x'; a()` written on a single line still counts the usage while the names inside the import list never count. `countUsages` itself still implements the documented line-based `excludeLines` parameter. For `const|let|var X = require('m')` the statement span starts at the declaration keyword.
- `analyzeReferences` checks skip reasons in the order `excluded`, `too-large`, `binary`, `unsupported-language` (cheap checks first; a NUL-containing `.png` reports `binary`).
- `loadProjectInfo` keeps the `roots` it is given (empty list falls back to `[dirname(file)]`); the `[dirname(file)]` rule for files outside every workspace folder is applied by `vscode/referenceService.ts`.
- Root-relative specifiers (`/x` in JS/HTML/Markdown, C includes, Ruby/PHP/Java roots) are tried against every workspace root, the root(s) containing the file first.
- Binding conventions not fixed by the contract: `import x = require('m')` and `const x = require('m')` give `{ local: 'x', imported: '*' }`; `export ... from` statements have no bindings (the re-exported names are not locals); Python `import a.b.c` gives `{ local: 'a.b.c', imported: '*' }` and an alias gives `{ local: alias, imported: '*' }`.
- Rust `use a::b::{C, D as E}` is one statement (`specifier: 'a::b'`, bindings `C`, `D as E`); a single `use a::b::C;` has specifier `a::b::C` and the resolver tries the full path first, then shorter prefixes. A group member that is itself a submodule file becomes its own target. PHP group use (`use A\B\{C, D}`) yields one statement per class, because every class is a different file.
- `ReferenceService.invalidate(prefix)` returns the sources whose cached result mentioned the path (instead of `void`) so the controller can re-request the active ones.
- Webview details beyond the DOM contract: `ul.fs-tree` is always present; `.fs-empty` exists only in the `empty` / `disabled` states; `data-state` stays `rows` while leaving rows are still fading out; `lastSeq` starts at -1; the first snapshot after `mountApp` is a baseline for "auto-expand on new file" (so restored collapsed folders stay collapsed); a folder toggle handles Enter in `keydown` and leaves Space to the native `<button>` click; `.fs-row` handles Enter/Space itself. Elements are created/looked up through maps keyed by id (never selectors built from file names). The webview never recomputes shake from intensity: it renders `row.shake` as given.
- `window.state.focused` in test mode is `focusOverride ?? true`; the controller refreshes immediately when a file first appears or its source flips, otherwise on the next 200 ms tick (so a burst of keystrokes costs at most 5 model rebuilds per second).
- **Clean-after-change documents are settled before classification (found in real VS Code 1.129.1).** For the *first* edit of a clean document VS Code fires `onDidChangeTextDocument` while `document.isDirty` is still `false`, and the dirty flag flips in a separate event (empty `contentChanges`, `isDirty === true`) right after. Applying DESIGN 7.3 row 4 literally classified that first keystroke as `external / reload-from-disk` (the real-host smoke test caught it: `TextEditor.edit` on a clean file gave `external`). `vscode/editWatcher.ts` therefore parks a content-change event that arrives clean (and is not saving / undo / redo) for `DIRTY_SETTLE_MS = 150` ms on the injected scheduler: if the dirty event arrives first the change is classified with `isDirtyAfter = true` (rows 5/6: `you / active-focused-edit` or `external / background-edit`); if the timer fires first it is classified with `isDirtyAfter = false` (`external / reload-from-disk`, a real reload or revert). `core/sourceClassifier.ts` is unchanged (pure table). Consequence for tests: in test mode that timer lives on the `ManualScheduler`, so an external *reload* classification needs `testing.advance(150)`; typing needs nothing (the dirty event settles it) but arrives asynchronously, so wait on `api.onDidUpdate` instead of reading rows right after `await editor.edit(...)`.
- `FileShakeApi.testing` gained `viewStats(): { resolved, ready, sent, visible }` (test seam only) so integration tests can assert that the Explorer view was resolved, posted `ready` and received a snapshot without poking at the webview DOM.
- `vscode/referenceService.ts` answers unsupported languages (by `languageId`/extension) and files above `maxFileSizeKb` (by `stat`, no read) with a stored `skipped` result before reading any text.
- `FileShakeApi.testing` gained `pendingTimers(): number` (test seam only, same `FILE_SHAKE_TEST=1` gate) so the "zero timers when idle" and "no timers after dispose" checks can be asserted. The controller, `ReferenceService` (it receives the controller's scheduler) and `EditWatcher` all use the one `ManualScheduler` created in `activate`, so the count is simply `ManualScheduler.pending`: it covers the 200 ms tick chain, the 400 ms reference debounces, the 5 s will-save safety timers and the 150 ms dirty-state parking timers. Nothing in `src/` uses a timer outside that scheduler (the real `systemScheduler` is only used outside test mode).
- **Phase 2 fixes (QA-003..QA-006, QA-002).** (a) After a rename, folder-root change, project-file change or analysis-setting change, reference results are re-requested for every source that is on screen: active files, plus idle files while `showWhenIdle` is on (previously active only, so idle rows lost their references; QA-003). (b) `applyConfig` restarts the removal tick when a setting change leaves idle rows waiting to be removed, e.g. `showWhenIdle` switched off (QA-004). (c) `ActivityTracker.renameUnder` returns the number of re-keyed entries and `ActivitySink.onRenamed` returns `boolean` (tracked state moved); only then is the rename recorded as VS Code's own write, so a rename of an untracked file still shows the new name as `external` as before (QA-005). (d) `external` document events go through `BurstGuard` (QA-006). (e) The reference cache key for open documents is `doc:<identity>:<version>` instead of `doc:<version>`, because a document closed unsaved and re-opened is a new object whose version restarts at 1 (QA-002; the integration reproducer skips itself when VS Code keeps the text model alive, as it does in 1.129.1, so this one is reasoned, not demonstrated).
