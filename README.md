# File Shake

Make file activity visible. File Shake watches which file is being changed, whether **you are typing** in it or **something else (Claude Code, git, a formatter, a build tool)** is writing it, and shows it live:

- the file being edited is **green** and **shakes** in proportion to how fast it is being changed;
- the files that file **references** (imports, requires, includes) turn **yellow** and shake in proportion to **how many times they are referenced** from it;
- both show up in a compact **File Shake** tree in the Explorer sidebar, folders expanded down to each file, and are tinted in the real Explorer tree too.

Everything is configurable (`fileShake.*`), respects `prefers-reduced-motion`, and works in light, dark and high-contrast themes.

## What it can and cannot do (please read)

These are limits of the VS Code extension API and of static analysis, not bugs. File Shake is built around them instead of pretending otherwise.

1. **The native Explorer tree cannot shake.** VS Code lets extensions decorate Explorer rows only with a colour, a badge and a tooltip; there is no way to animate or restyle them. So File Shake has two layers:
   - **Native Explorer layer**: edited files are tinted green, referenced files yellow, with a short badge and tooltip (and, optionally, their parent folders are tinted too). No motion.
   - **Live "File Shake" view** (a webview in the Explorer sidebar): a tree of *only the involved files*, with the CSS shake animation. This is where the shaking happens.
2. **The native badge cannot say `typing`, `external` or `×N refs`.** Explorer badges are limited to 1-2 characters. Natively you get `●` (edited by you), `◆` (changed externally) and the reference count `1`..`9` / `9+` for referenced files. The words (`typing`, `external`, `×3 refs`) appear in the File Shake view and in tooltips.
3. **Colours.** Native decorations can only use contributed theme colours, so to change the Explorer colours override `fileShake.editedForeground` and `fileShake.referencedForeground` in `workbench.colorCustomizations`. The settings `fileShake.colors.edited` / `fileShake.colors.referenced` (empty = follow the theme) change **the File Shake view only**. Defaults: green `#3fb950`, yellow `#e3b341` (darker tones in light themes for contrast).
4. **File Shake cannot tell "Claude" from other writers.** The API does not say who wrote a file. It distinguishes *typing in the focused editor* (`you`) from *any other change* (`external`): Claude Code, git checkout/pull, formatters, code generators, build tools, other extensions, sync clients. The label is `external`, never "Claude".
5. **Reference counts are heuristic.** References are found with a fast token scan (not a full parser or type checker), so shadowed names, same-package references in Go/Java, bundler aliases and package `exports` are not understood. See "How references are counted".
6. **Yellow only shows while you are editing.** Yellow rows exist while a source file is active (or with `fileShake.showWhenIdle`); merely focusing or opening a file does not surface its references.

## How "you" versus "external" is decided

For each change File Shake looks at how it arrived:

| Signal | Result |
|---|---|
| Content change in the focused editor, window focused (typing, paste, multi-cursor) | `you` |
| Undo / redo | `you` |
| Document reloaded from disk (clean document changed by something else) | `external` |
| Dirty document changed while it is not the focused editor (a `WorkspaceEdit`, a rename refactor, an agent API) | `external` |
| File-system change event for a file (watcher) | `external` |
| Edits made while saving (format on save) or file events within 2 s of your own save | ignored |
| Non-file documents (untitled, git, output, notebook cells) | ignored |
| More than 30 distinct files per second (checkout, codegen) | suppressed for 3 s |

**Reliability, plainly:**

- `you` is reliable for ordinary typing, paste, undo/redo and multi-cursor in the focused editor. It is **falsely reported** when another extension inserts text into the focused editor (Copilot/inline completions, snippets) and when an agent applies a `WorkspaceEdit` to the *active* document while the window is focused: that is indistinguishable from typing.
- `external` means "changed without keystrokes in the focused editor". Claude Code (CLI or IDE) normally writes to disk, which produces a watcher event (and a reload event if the file is open and clean), so it is classified correctly. The same label is given to everything else that changes files.
- **Misses**: writes to paths hidden by `files.watcherExclude` or by `fileShake.excludeGlobs` (document events still work for open files); an external write within 2 s after your own save of the same file is treated as your save; an external write to a *dirty* open document is still reported by the watcher, but the editor does not reload it.
- **Latency**: file-system events arrive 50-500 ms after the write, so the first shake lags slightly.
- Window unfocused + programmatic edits count as `external`. Merely opening or focusing a file is never activity.

## How references are counted

For the file being edited, File Shake finds its imports and resolves them to real files in your workspace. The reference count of a target is **the number of import statements pointing at it plus the number of times the imported names are used** in the edited file; the shake of a yellow row grows with the log of that count.

Supported: TypeScript/JavaScript (ES `import`, `export … from`, `require`, dynamic `import()`, tsconfig/jsconfig `paths`/`baseUrl`/`extends`), Python (absolute and relative), Go (via `go.mod`), Java/Kotlin, C/C++ (`#include "…"`), Rust (`mod`, `use crate::…`), Ruby (`require_relative`, `require`), PHP (`require`/`include`, `use`, composer PSR-4), CSS/SCSS/Less (`@import`, `@use`, `@forward`), HTML (`src`/`href`) and Markdown links.

Known limits: regex/token based, not semantic; shadowing is not modelled; Go and Java import maps to one file per import and implicit same-package references are not found; bundler aliases (webpack/vite) and package `exports` are ignored; dynamic `require(variable)` is ignored; no Vue/Svelte/Astro templates; bare packages (`react`, `lodash`) are never shown (nothing from `node_modules`); generated and minified files are excluded by default.

Analysis never blocks the extension host: it is debounced (400 ms after the last edit), capped (file size, number of statements and file probes, time) and cached per document version.

## Commands

| Command | What it does |
|---|---|
| `File Shake: Toggle On/Off` | Enables or disables File Shake (also available in the view title bar). |
| `File Shake: Clear` | Forgets all tracked files and cached references. |
| `File Shake: Focus View` | Reveals the File Shake view (also: click the status bar item). |
| `File Shake: Show Debug Info` | Writes tracked files, rows, reference results and the last classification decisions to the "File Shake" output channel. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `fileShake.enable` | `true` | Master switch. |
| `fileShake.enableAnimation` | `true` | Shake rows in the view. Colours, badges and the intensity meter always show. Also off when the OS asks for reduced motion. |
| `fileShake.idleTimeoutMs` | `2500` | Time without edits after which a file is idle. |
| `fileShake.windowMs` | `3000` | Sliding window for the edit rate. |
| `fileShake.maxFiles` | `40` | Maximum rows shown. |
| `fileShake.excludeGlobs` | build output, `node_modules`, `.git`, lock files, … | Files that are never tracked or shown as references. |
| `fileShake.colors.edited` / `fileShake.colors.referenced` | `""` | View colours (`#rgb`, `#rrggbb`, `#rrggbbaa`); empty follows the theme. Webview only (see limit 3). |
| `fileShake.sensitivity` | `1` | 0.25-4; higher shakes harder for the same activity. |
| `fileShake.showWhenIdle` | `false` | Keep idle files and their references listed. |
| `fileShake.decorateFolders` | `true` | Tint parent folders of active files in the Explorer. |
| `fileShake.detectExternalEdits` | `true` | Track changes that are not typing and label them `external`. |
| `fileShake.maxFileSizeKb` | `512` | Larger files are tracked but not scanned for references. |
| `fileShake.showStatusBar` | `true` | Status bar item (`index.ts · typing · 3 refs`). |

## Requirements and remote use

VS Code 1.85 or newer. The extension runs where your files are (`extensionKind: workspace`), so it works in Remote-SSH, WSL and dev containers. In virtual workspaces (no real file system) only part of it works, because file watching and import resolution need real files. It works with no folder open (typing is tracked, nothing is resolved) and in multi-root workspaces.

## Privacy

File Shake makes no network requests and sends nothing anywhere. The webview loads no remote resources (strict content security policy with a nonce, no inline scripts or handlers).

## License

MIT, see `LICENSE`.
