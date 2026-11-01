# File Shake — Product Brief (source of truth for all agents)

A VS Code extension, installable by anyone, that makes file activity *visible*.

## What the user asked for (verbatim intent)

1. Track which file is being changed/updated — whether **the user is typing** or **Claude (or any
   external tool) is editing** it.
2. The file being edited **shakes**, in proportion to the keystrokes / how frequently it is updated.
3. Files that the edited file **references** (imports/requires/includes — "every class within that
   file that makes references to any file") also surface **in the folder tree**, and **shake in
   proportion to how many times they are referenced** from the current file.
4. Colors: the file being edited = **green**. Files referenced by that file = **yellow**.
   Yellow applies *while the person is typing/editing*.
5. Must be a real VS Code extension that anyone can install (a `.vsix`, Marketplace-ready).

## Known platform constraint (design around it, do not pretend otherwise)

VS Code's extension API **cannot animate or restyle the native Explorer tree rows**. The only
native hooks are `FileDecorationProvider` (badge, tooltip, text color via `ThemeColor`) — no motion.
Therefore the design is two-layered:

- **Native Explorer layer**: `FileDecorationProvider` tints edited files green and referenced files
  yellow (contributed theme colors, user-overridable), with a short badge and tooltip.
- **Live "File Shake" view**: a `WebviewViewProvider` registered in the Explorer sidebar that
  renders a compact folder tree of *only the involved files*, folders auto-expanded down to each
  file, with CSS animation for the shake. This is where the shaking actually happens.

The README must state this honestly.

## Detection of activity

- **User typing**: `onDidChangeTextDocument` on the active editor (count content changes, not just
  events; paste = one big burst).
- **External edits (Claude Code etc.)**: `FileSystemWatcher` change/create events and
  `onDidChangeTextDocument` for documents that are not being typed in (e.g. reloaded from disk).
  Distinguish the *source* (`you` vs `external`) so the view can label it.
- Intensity is derived from a sliding window of recent edit events (edits/sec) with decay after an
  idle timeout. Intensity is a number in [0, 1].

## Reference detection

- From the focused file's text, find imports/includes for at least: TS/JS (ES import, require,
  dynamic import, export-from), Python (import / from-import, relative), Go, Java/Kotlin, C/C++
  (`#include "..."`), Rust (`mod`/`use` crate-local), Ruby (`require_relative`), PHP, CSS/SCSS
  (`@import`/`@use`), HTML (`src`/`href`), Markdown links optional.
- Resolve to real workspace files (extension probing, `index.*`, `__init__.py`, tsconfig
  `paths`/`baseUrl` best-effort).
- **Reference count** per target file = number of import statements + number of identifier usages
  of the symbols imported from it, within the focused file. Shake intensity is a log-scaled
  normalization of that count.
- Must not block the extension host: debounce, cap file size, cap number of references, cache.

## Visual spec

- Edited file: **green** (default `#3fb950`), shake amplitude/speed scales with edit rate.
- Referenced file: **yellow** (default `#e3b341`), shake scales with reference count.
- Both colors configurable and exposed as theme colors for native decorations.
- A file that is both edited and referenced → green wins.
- Respect `prefers-reduced-motion` and a `fileShake.enableAnimation` setting (color still shows).
- Works in light, dark, and high-contrast themes.
- Clicking a row opens the file. Rows show name, relative folder, and a tiny badge
  (`typing`, `external`, `×N refs`).

## Non-functional requirements

- TypeScript `strict`, no `any`, bundled with esbuild, `engines.vscode` >= 1.85.
- Webview: strict CSP with nonce, no remote resources, no inline event handlers.
- Everything disposable; no leaks; works in multi-root workspaces and with no folder open.
- Activation: `onStartupFinished` (cheap), nothing heavy at startup.
- Settings under `fileShake.*` (enable, animation, idle timeout, window size, max files,
  exclude globs, colors, sensitivity, show-when-idle).
- Commands: toggle on/off, clear, focus the view, show debug info.
- Status bar item showing the currently-tracked file and state.
- Packaged via `@vscode/vsce` into a `.vsix` that installs cleanly. Includes README, CHANGELOG,
  LICENSE (MIT), 128×128 PNG icon, `.vscodeignore`, gallery banner.

## Testing requirements ("test everything")

- Pure logic (activity tracker, intensity math, reference parsers/resolver) is in modules that do
  **not** import `vscode`, so they can be unit-tested fast.
- Unit tests: tracker windowing/decay, intensity math, every language parser, resolver edge cases.
- Integration tests with `@vscode/test-electron` in a real VS Code instance: activation, view
  registered, typing simulation changes state, file watcher path, decorations returned, commands.
- Webview render test: the webview HTML/JS is exercised headlessly (jsdom or the
  `browser-automation` skill) — rows render, classes/CSS variables set, reduced motion honored.
- `npm run package` produces a `.vsix`; verify its contents and that it installs.

## Layout (agreed)

```
file-shake/
  package.json  tsconfig.json  esbuild.mjs  .vscodeignore  LICENSE  README.md  CHANGELOG.md
  src/
    extension.ts            # activate/deactivate wiring only
    core/                   # NO vscode imports
      activityTracker.ts
      intensity.ts
      references/ (parsers per language, resolver, index)
      types.ts
    vscode/                 # vscode-facing adapters
      editWatcher.ts  decorationProvider.ts  shakeViewProvider.ts  statusBar.ts  config.ts
  media/  (webview js/css, icon)
  test/   unit/  integration/  fixtures/
  docs/   BRIEF.md  DESIGN.md  QA_REPORT.md
```

The Architect may refine this layout in `docs/DESIGN.md`; after that, `DESIGN.md` wins.
