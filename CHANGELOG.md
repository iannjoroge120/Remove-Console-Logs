# Change Log

All notable changes to the "Console Logs Remover" extension are documented in this file.

## [1.1.0]

### Added
- **Apply to all or pick and choose:** a review checklist (click the status bar count, or *Review Console Logs in Workspace*) with everything checked, filtering, toggle-all, and Remove / Comment out / Keep for the checked logs.
- **Checkboxes in the Console Logs view**, with Select All, Clear Selection, and Remove / Comment Out / Keep for the selection, or for everything listed when nothing is selected.
- **Undo history:** Undo All Changes and Show Change History (up to 20 steps). The summary notification offers Undo All.
- **Keep** action: adds `// keep-log` to many calls at once, from the view, the review list, the CLI or AI tools.
- **AI tools for Copilot agent mode and other VS Code chat agents:** `#consoleLogs` and `#removeConsoleLogs`, with confirmation in chat and normal undo.
- **CLI and MCP server** (`npx console-logs-remover`) for Claude Code, Cursor, CI and pre-commit hooks: `--check`, `--fix`, `--comment`, `--keep`, `--uncomment`, `--changed`, `--staged`, `--json`, `--dry-run`. It reads `.vscode/settings.json`.
- **Set Up AI Agents** command.
- Quick Fixes: *Review all console calls in file* and *Remove all console calls in workspace*.

### Changed
- Requires VS Code 1.95 or later.
- The extension now has no runtime dependencies. Everything is bundled.

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
