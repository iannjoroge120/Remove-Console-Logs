# Change Log

All notable changes to the "Console Logs Remover" extension are documented in this file.

## [1.0.0]

A rewrite. Removal now parses your code instead of using a regular expression.

### Fixed
- Logs containing nested parentheses, strings with `)`, template literals or regexes no longer leave broken code behind.
- Logs that are the body of an `if`, a loop or an arrow function are replaced with `{}` instead of being deleted into a syntax error.
- Commented-out logs and logs inside strings are no longer touched.
- Undo now restores every changed file, not just the last one, and never overwrites edits made after the removal.
- One summary notification instead of one per file.

### Added
- Scopes: current file, selection or cursor line, Explorer folders and files, the whole workspace, and **only lines changed since the last git commit**.
- Refactor preview with per-change checkboxes when more than one file changes (`consoleLogsRemover.preview`).
- `consoleLogsRemover.methods`: choose which console methods to remove. `warn` and `error` are kept by default.
- `// keep-log` comment to protect individual calls.
- Include/exclude globs and `.gitignore` support. Build output and `node_modules` are skipped by default.
- Vue, Svelte, Astro, HTML, `.mjs`, `.cjs`, `.mts` and `.cts` support.
- Comment out and uncomment commands.
- Status bar count with a quick pick for jumping to or removing logs.
- *Console Logs* view in the Explorer.
- Editor hints with Quick Fixes, plus a `source.removeConsoleLogs` code action for `editor.codeActionsOnSave`.
- **Insert Console Log** (`Ctrl+Alt+L`), with tagged logs and **Remove Inserted (Tagged) Logs**.
- Keybinding `Ctrl+Alt+Shift+L` to remove logs in the current file.
- Unit and integration tests.

## [0.3.1]
- Fixed bugs that removed more than console log statements, and fixed undo.
