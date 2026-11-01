# Changelog

## 0.2.0

Rows now stay, and there are two users.

- **Rows persist.** A file stays on screen after it stops shaking (dimmed, with its yellow references) until whoever changed it moves on. Your file stays until you switch to a different file or leave the VS Code window; a file changed by something else stays until that something changes a different file. Files changed at the same time are shown together. New setting `fileShake.persistUntilNextFile` (default on); turn it off for the old behaviour of removing idle files a few seconds after they stop.
- **Two users in the view.** The File Shake tree now has a **You** section (typing in the editor) and an **External** section (Claude Code, git, formatters, build tools), each with its own files and its own yellow references. Yellow files follow the user whose file references them.
- Clicking a row in the File Shake view no longer counts as switching files.
- Reference results are cached per document object, not just per version number, so a document closed unsaved and re-opened never shows the previous buffer's references.
- Fixed: renaming an unrelated file dropped the references of idle files; turning `showWhenIdle` off left idle rows on screen; renaming a file you were typing in relabelled it as external; a checkout rewriting open files was not treated as a flood.

## 0.1.0

Initial release.

- Live "File Shake" Explorer view: edited files green, referenced files yellow, shaking in proportion to edit rate and reference count; folders auto-expanded down to each file; click a row to open it.
- Native Explorer decorations (colour, badge, tooltip) through contributed theme colours `fileShake.editedForeground` and `fileShake.referencedForeground`.
- Source detection: `you` (typing in the focused editor) versus `external` (any other change), with self-save and burst protection.
- Reference detection for TypeScript/JavaScript, Python, Go, Java/Kotlin, C/C++, Rust, Ruby, PHP, CSS/SCSS/Less, HTML and Markdown.
- Status bar item, commands (toggle, clear, focus view, show debug info) and `fileShake.*` settings.
- Honors `prefers-reduced-motion`; strict CSP webview; light, dark and high-contrast themes.
