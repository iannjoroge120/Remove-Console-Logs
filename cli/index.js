const { scanProject, applyToProject } = require('../src/core/project');
const { version } = require('../package.json');

const HELP = `console-logs-remover ${version}

Find and remove console.log calls safely (JS, TS, JSX, Vue, Svelte, Astro, HTML).

Usage
  console-logs-remover [paths...] [options]
  console-logs-remover mcp [--root <dir>]       Start an MCP server for AI agents

Actions (default: --check)
  --check            List console calls; exit 1 if any are found
  --fix              Remove them
  --comment          Comment them out
  --keep             Mark them with the ignore comment so they are kept
  --uncomment        Restore commented-out console calls

Scope
  --changed          Only lines changed since the last commit (incl. unstaged)
  --staged           Only staged lines (with --check; for pre-commit hooks)
  --methods <list>   Comma-separated methods, e.g. log,debug (default: all but warn/error)
  --exclude <glob>   Extra glob to skip (repeatable)
  --no-gitignore     Also scan git-ignored files
  --root <dir>       Project root (default: current directory)

Output
  --json             Machine-readable output
  --dry-run          Show what would change without writing files
  -h, --help         Show this help
  -v, --version      Show the version

Settings in .vscode/settings.json (consoleLogsRemover.*) are honoured.

Examples
  npx console-logs-remover --changed --fix     Clean up your debugging before committing
  npx console-logs-remover --staged            Pre-commit check
  npx console-logs-remover src --json          List calls for an AI agent or script
`;

function parseArgs(argv) {
    const args = { paths: [], extraExclude: [], action: 'check', json: false, dryRun: false };
    const actions = { '--check': 'check', '--fix': 'remove', '--comment': 'comment', '--keep': 'keep', '--uncomment': 'uncomment' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return next;
        };
        if (actions[arg]) {
            args.action = actions[arg];
        } else if (arg === '--changed') {
            args.changed = true;
        } else if (arg === '--staged') {
            args.staged = true;
        } else if (arg === '--methods') {
            args.methods = value().split(',').map(s => s.trim()).filter(Boolean);
        } else if (arg === '--exclude') {
            args.extraExclude.push(value());
        } else if (arg === '--no-gitignore') {
            args.respectGitignore = false;
        } else if (arg === '--root') {
            args.root = value();
        } else if (arg === '--json') {
            args.json = true;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '-h' || arg === '--help') {
            args.help = true;
        } else if (arg === '-v' || arg === '--version') {
            args.version = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            args.paths.push(arg);
        }
    }
    return args;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function check(args, out) {
    const { files } = await scanProject(args);
    const found = files.filter(f => f.calls.length);
    const total = found.reduce((n, f) => n + f.calls.length, 0);
    const errors = files.filter(f => f.error);

    if (args.json) {
        out.log(JSON.stringify({
            total,
            files: found.map(f => ({
                path: f.rel,
                calls: f.calls.map(c => ({ line: c.line + 1, column: c.start - lineStartOf(f.text, c.start) + 1, method: c.method, code: c.snippet }))
            })),
            errors: errors.map(f => ({ path: f.rel, error: f.error }))
        }, null, 2));
    } else {
        for (const file of found) {
            out.log(file.rel);
            for (const call of file.calls) {
                const column = call.start - lineStartOf(file.text, call.start) + 1;
                out.log(`  ${call.line + 1}:${column}  ${call.snippet}`);
            }
        }
        errors.forEach(f => out.error(`Could not parse ${f.rel}: ${f.error}`));
        if (total) {
            const hint = args.staged ? 'remove them or mark them with // keep-log' : `run with --fix to remove them${args.changed ? '' : ', or --changed --fix for just your changes'}`;
            out.log(`\n✖ ${plural(total, 'console call')} in ${plural(found.length, 'file')} (${hint})`);
        } else {
            out.log('✔ No console calls found');
        }
    }
    return total ? 1 : 0;
}

function lineStartOf(text, offset) {
    return text.lastIndexOf('\n', offset - 1) + 1;
}

async function apply(args, out) {
    const summary = await applyToProject(args.action, args);
    if (args.json) {
        out.log(JSON.stringify(summary, null, 2));
        return summary.errors.length ? 2 : 0;
    }
    const verbs = { remove: 'Removed', comment: 'Commented out', keep: 'Marked to keep', uncomment: 'Restored' };
    const verb = summary.dryRun ? `Would have ${verbs[summary.mode].toLowerCase()}` : verbs[summary.mode];
    summary.files.forEach(f => out.log(`  ${f.rel}  (${f.count})`));
    summary.errors.forEach(e => out.error(`Could not parse ${e}`));
    const notes = [];
    if (summary.kept) {
        notes.push(`${summary.kept} kept by ignore comment`);
    }
    if (summary.skipped) {
        notes.push(`${summary.skipped} skipped: share a line with other code`);
    }
    out.log(`${summary.count ? '✔' : '•'} ${verb} ${plural(summary.count, 'console call')} in ${plural(summary.files.length, 'file')}${notes.length ? ` (${notes.join('; ')})` : ''}`);
    return summary.errors.length ? 2 : 0;
}

async function main(argv = process.argv.slice(2), out = console) {
    if (argv[0] === 'mcp') {
        const rootIndex = argv.indexOf('--root');
        require('./mcp').startServer({ root: rootIndex > -1 ? argv[rootIndex + 1] : process.cwd() });
        return null;
    }
    let args;
    try {
        args = parseArgs(argv);
    } catch (err) {
        out.error(`${err.message}\nRun with --help for usage.`);
        return 2;
    }
    if (args.help) {
        out.log(HELP);
        return 0;
    }
    if (args.version) {
        out.log(version);
        return 0;
    }
    try {
        return args.action === 'check' ? await check(args, out) : await apply(args, out);
    } catch (err) {
        out.error(err.message);
        return 2;
    }
}

module.exports = { main, parseArgs };
