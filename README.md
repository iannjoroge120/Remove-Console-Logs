# Console Logs Remover

Find, review and clean up `console.log` calls without breaking your code, by hand, in bulk, or through your AI agent. It works in JavaScript, TypeScript, React (JSX/TSX), Vue, Svelte, Astro and HTML.

The extension parses your code instead of matching text. It knows that `console.log(fn(a), b)` ends at the second `)`, ignores `console.log` inside strings and comments, and keeps code valid when a log is the only statement in an `if` or an arrow function.

## Features

### Remove logs, at any scope
- **Current file:** `Ctrl+Alt+Shift+L`, or right-click → *Console Logs* → *Remove Console Logs in Current File*
- **Selection or cursor line:** removes only the logs you've selected
- **Folder or files:** right-click in the Explorer → *Remove Console Logs*
- **Whole workspace:** from the Command Palette or the *Console Logs* view
- **Only lines I changed:** removes logs from lines added or edited since your last git commit, including unsaved edits. Clean up your debugging before you commit without touching logs that were already there.

### Apply to all, or pick and choose
- **Review list** (click the status bar count, or *Console Logs: Review Console Logs in Workspace*): every log in a checklist, all checked to start. Press **Enter** to remove them all, or untick some first. Type to filter (e.g. `debug`), then use the toggle-all checkbox to select only the filtered ones. The buttons at the top **comment out** or **keep** the checked logs instead.
- **Console Logs view:** tick files or individual logs, then use **Remove Selected**, **Comment Out Selected** or **Keep Selected**. With nothing ticked, the same buttons apply to **everything listed**. **Select All** and **Clear Selection** are in the toolbar.
- **Preview:** when more than one file would change, you get VS Code's refactor preview, where you can untick individual changes.

### Undo one step, or undo everything
Every change gets one summary with **Undo**, plus **Undo All** once there's more than one change to undo. The extension keeps a history of up to 20 changes:
- *Console Logs: Undo Last Change*
- *Console Logs: Undo All Changes*
- *Console Logs: Show Change History*: pick how far back to go

Undo never overwrites edits you made afterwards. A file you've changed since is left alone and reported.

### Keep the logs you mean to keep
- `console.warn` and `console.error` are kept by default. Choose exactly which methods to remove with `consoleLogsRemover.methods`.
- Add `// keep-log` on the same line or the line above to protect a specific call.
- `node_modules`, `dist`, `build`, `.next`, coverage and minified files are skipped, and so is anything in `.gitignore`.

### See them before you remove them
- **Status bar count** of logs in the current file. Click it to open the review list.
- **Console Logs view** in the Explorer: every log in the workspace grouped by file, with checkboxes and inline keep, comment-out and remove buttons.
- **Editor hints** with Quick Fixes (`Ctrl+.`): *Remove*, *Comment out*, *Keep this (add // keep-log)*, *Remove all in file*, *Review all in file* or *Remove all in workspace*.

### Comment out instead of deleting
*Comment Out Console Logs* turns logs into `// console.log(...)` lines, and *Uncomment Console Logs* brings them back, including multi-line calls.

### Insert logs too
Put the cursor on a variable (or select an expression) and press `Ctrl+Alt+L`:

```js
const user = await getUser(id);
console.log('🪵 api.js:12 ~ user:', user);
```

The log goes after the whole statement, before a `return`, or at the top of a function or loop body for parameters and loop variables. It works with multiple cursors. Inserted logs start with a tag (🪵), so **Remove Inserted (Tagged) Logs** removes only your debugging and leaves logs that were already in the codebase.

### Remove on save (optional)
The extension provides a `source.removeConsoleLogs` code action, so you can strip logs automatically, for example only in production code folders:

```json
"editor.codeActionsOnSave": {
  "source.removeConsoleLogs": "explicit"
}
```

## Use it with AI agents
AI coding agents add a lot of `console.log` while they debug. Let them clean up after themselves with the same engine, settings and safety checks. Run **Console Logs: Set Up AI Agents** to configure any of these.

### Copilot and other VS Code chat agents
Two tools are built in, so agent mode can use them directly:
- `#consoleLogs` finds console calls in the current file, the workspace, or only your uncommitted changes.
- `#removeConsoleLogs` removes, comments out, keeps or uncomments them. You confirm in chat before anything changes, and **Undo** / **Undo All** work as usual.

Try: *"Remove the console logs you added in this task"*.

### Claude Code, Cursor, Claude Desktop (MCP)
The `console-logs-remover` package includes an MCP server with `find_console_logs` and `remove_console_logs` tools:

```bash
claude mcp add console-logs -- npx -y console-logs-remover mcp
```

For Cursor and other clients, add this to their MCP config (e.g. `.cursor/mcp.json`):

```json
{ "mcpServers": { "console-logs": { "command": "npx", "args": ["-y", "console-logs-remover", "mcp"] } } }
```

### Command line, CI and pre-commit
```bash
npx console-logs-remover                    # list console calls (exit code 1 if any)
npx console-logs-remover --changed --fix    # remove only the ones on lines you changed
npx console-logs-remover --staged           # pre-commit check on staged lines
npx console-logs-remover src --json         # machine-readable output
```
Also: `--comment`, `--keep`, `--uncomment`, `--dry-run`, `--methods log,debug`, `--exclude <glob>`. The CLI reads the same `consoleLogsRemover.*` settings from `.vscode/settings.json`, so your whole team and your agents follow the same rules.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `consoleLogsRemover.methods` | `log`, `debug`, `info`, `trace`, `table`, `dir`, `time*`, `count*`, `group*` | Which `console` methods to find and remove |
| `consoleLogsRemover.exclude` | `node_modules`, `dist`, `build`, … | Globs skipped by workspace and folder commands |
| `consoleLogsRemover.include` | JS/TS/Vue/Svelte/Astro/HTML files | Files processed by workspace and folder commands |
| `consoleLogsRemover.respectGitignore` | `true` | Skip git-ignored files |
| `consoleLogsRemover.ignoreComment` | `keep-log` | Comment text that protects a call |
| `consoleLogsRemover.preview` | `multipleFiles` | When to show the diff preview: `multipleFiles`, `always` or `never` |
| `consoleLogsRemover.saveAfterChange` | `false` | Save files automatically after a change |
| `consoleLogsRemover.diagnostics.severity` | `hint` | How logs are marked in the editor (`off` to hide) |
| `consoleLogsRemover.statusBar.enabled` | `true` | Show the per-file count |
| `consoleLogsRemover.insertLog.prefix` | `🪵` | Tag that starts inserted logs |
| `consoleLogsRemover.insertLog.includeLocation` | `true` | Add `file:line` to inserted logs |
| `consoleLogsRemover.insertLog.quote` | `'` | Quote style for inserted logs |
| `consoleLogsRemover.insertLog.method` | `log` | Console method used by Insert Log |

## How removal keeps code valid

| Before | After |
|---|---|
| `console.log(a);` on its own line | the line is removed |
| `if (x) console.log(x);` | `if (x) {}` |
| `const f = () => console.log(x);` | `const f = () => {};` |
| `debug && console.log(x);` | removed |
| `const y = console.log(x) \|\| 1;` | `const y = undefined \|\| 1;` |
| `<div>{console.log(x)}</div>` | `<div>{undefined}</div>` |

Files that can't be parsed are skipped and listed in the *Console Logs Remover* output channel. They are never edited.

## Workspace trust
The git-based features (*Only lines I changed* and respecting `.gitignore`) run `git`, so they're disabled in untrusted workspaces. Everything else works.

Requires VS Code 1.95 or later.

---

- **Twitter:** [@iannjoroge120](https://twitter.com/iannjoroge120)
- **LinkedIn:** [Ian Njoroge](https://www.linkedin.com/in/ian-njoroge-42b43a180/)
- **Email:** [iannjoroge120@gmail.com](mailto:iannjoroge120@gmail.com)
