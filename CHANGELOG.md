# Changelog

## 0.1.0

Initial release.

- Live "File Shake" Explorer view: edited files green, referenced files yellow, shaking in proportion to edit rate and reference count; folders auto-expanded down to each file; click a row to open it.
- Native Explorer decorations (colour, badge, tooltip) through contributed theme colours `fileShake.editedForeground` and `fileShake.referencedForeground`.
- Source detection: `you` (typing in the focused editor) versus `external` (any other change), with self-save and burst protection.
- Reference detection for TypeScript/JavaScript, Python, Go, Java/Kotlin, C/C++, Rust, Ruby, PHP, CSS/SCSS/Less, HTML and Markdown.
- Status bar item, commands (toggle, clear, focus view, show debug info) and `fileShake.*` settings.
- Honors `prefers-reduced-motion`; strict CSP webview; light, dark and high-contrast themes.
