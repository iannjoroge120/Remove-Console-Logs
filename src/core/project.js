const fs = require('fs');
const path = require('path');
const { findConsoleCalls, DEFAULT_METHODS } = require('./finder');
const { fileKind } = require('./parse');
const { planRemoval, planCommentOut, planUncomment, planKeep } = require('./transform');
const { applyEdits } = require('./text');
const { createMatcher } = require('./glob');
const git = require('./git');

/**
 * Scanning and editing whole projects from Node, without VS Code. Used by the
 * CLI and the MCP server so AI agents and CI get the same behaviour as the
 * extension.
 */

const DEFAULTS = {
    methods: DEFAULT_METHODS,
    include: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,astro,html}',
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.nuxt/**', '**/coverage/**', '**/*.min.js'],
    respectGitignore: true,
    ignoreComment: 'keep-log'
};
const ALWAYS_SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

/** Strips comments and trailing commas so VS Code's JSONC settings parse as JSON. */
function parseJsonc(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\') {
                out += text[++i] || '';
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            i = text.indexOf('*/', i + 2);
            if (i === -1) {
                break;
            }
            i++;
        } else {
            out += c;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Reads consoleLogsRemover.* settings from <root>/.vscode/settings.json, if present. */
function readWorkspaceSettings(root) {
    try {
        const settings = parseJsonc(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8'));
        const prefix = 'consoleLogsRemover.';
        const result = {};
        for (const [key, value] of Object.entries(settings)) {
            if (key.startsWith(prefix)) {
                result[key.slice(prefix.length)] = value;
            }
        }
        return result;
    } catch {
        return {};
    }
}

/** Effective options: defaults, then workspace settings, then explicit options. */
function resolveOptions(options = {}) {
    const root = path.resolve(options.root || process.cwd());
    const settings = readWorkspaceSettings(root);
    const pick = key => options[key] !== undefined ? options[key] : settings[key] !== undefined ? settings[key] : DEFAULTS[key];
    return {
        root,
        paths: options.paths || [],
        methods: pick('methods'),
        include: pick('include'),
        exclude: (options.extraExclude || []).concat(pick('exclude')),
        respectGitignore: pick('respectGitignore'),
        ignoreComment: pick('ignoreComment'),
        changed: Boolean(options.changed),
        staged: Boolean(options.staged),
        locations: options.locations || null
    };
}

const toPosix = p => p.split(path.sep).join('/');
const real = p => {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
};

function walk(dir, files) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!ALWAYS_SKIPPED_DIRS.has(entry.name)) {
                walk(full, files);
            }
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
}

/**
 * Files to process. Explicitly named files are always included; files found
 * by walking directories must match `include`, not match `exclude`, and not be
 * git-ignored.
 * @returns {Promise<string[]>} real absolute paths
 */
async function collectFiles(opts) {
    const root = real(opts.root);
    const include = createMatcher([opts.include]);
    const exclude = createMatcher(opts.exclude);
    const targets = opts.paths.length ? opts.paths.map(p => path.resolve(opts.root, p)) : [root];
    const explicit = [];
    const walked = [];

    for (const target of targets) {
        let stat;
        try {
            stat = fs.statSync(target);
        } catch {
            throw new Error(`No such file or directory: ${target}`);
        }
        if (stat.isDirectory()) {
            walk(real(target), walked);
        } else {
            explicit.push(real(target));
        }
    }

    let filtered = walked.filter(file => {
        const rel = toPosix(path.relative(root, file));
        return include(rel) && !exclude(rel);
    });
    if (opts.respectGitignore) {
        const allowed = await git.listNonIgnoredFiles(root).catch(() => null);
        if (allowed) {
            filtered = filtered.filter(file => allowed.has(path.normalize(path.relative(root, file))));
        }
    }
    const supported = explicit.filter(file => fileKind(file));
    return [...new Set(supported.concat(filtered))].sort();
}

const withinLines = lines => call => {
    for (let line = call.line; line <= call.endLine; line++) {
        if (lines.has(line)) {
            return true;
        }
    }
    return false;
};

/**
 * Scans the project.
 * @returns {Promise<{root: string, files: {path: string, rel: string, text: string, calls: object[], kept: number, error: string|null}[]}>}
 */
async function scanProject(options = {}) {
    const opts = resolveOptions(options);
    const root = real(opts.root);
    let files = await collectFiles(opts);

    let lineFilters = null;
    if (opts.changed || opts.staged) {
        const listed = opts.staged ? await git.listStagedFiles(root) : await git.listChangedFiles(root);
        if (!listed) {
            throw new Error(`${root} is not inside a git repository.`);
        }
        const set = new Set(listed.map(real));
        files = files.filter(file => set.has(file));
        lineFilters = new Map();
    }

    let locationFilter = null;
    if (opts.locations) {
        locationFilter = new Map();
        for (const loc of opts.locations) {
            const file = real(path.resolve(opts.root, loc.path));
            if (!locationFilter.has(file)) {
                locationFilter.set(file, new Set());
            }
            locationFilter.get(file).add(Number(loc.line) - 1);
        }
        const fromLocations = [...locationFilter.keys()].filter(file => fileKind(file) && fs.existsSync(file));
        files = opts.paths.length ? files.filter(file => locationFilter.has(file)) : fromLocations;
    }

    const results = [];
    for (const file of files) {
        let text;
        try {
            text = opts.staged ? await git.stagedContent(file) : fs.readFileSync(file, 'utf8');
        } catch (err) {
            results.push({ path: file, rel: toPosix(path.relative(root, file)), text: '', calls: [], kept: 0, error: err.message });
            continue;
        }
        if (lineFilters) {
            lineFilters.set(file, opts.staged ? await git.stagedAddedLines(file) : await git.changedLines(file, text));
        }
        const result = findConsoleCalls(text, { fileName: file, methods: opts.methods, ignoreComment: opts.ignoreComment });
        let calls = result.calls;
        if (lineFilters) {
            calls = calls.filter(withinLines(lineFilters.get(file)));
        }
        if (locationFilter) {
            calls = calls.filter(withinLines(locationFilter.get(file) || new Set()));
        }
        results.push({
            path: file,
            rel: toPosix(path.relative(root, file)),
            text,
            calls: calls.filter(c => !c.ignored),
            kept: calls.filter(c => c.ignored).length,
            error: result.error
        });
    }
    return { root, options: opts, files: results };
}

/**
 * Removes, comments out, keeps or uncomments console calls across the project.
 * @param {'remove'|'comment'|'keep'|'uncomment'} mode
 * @returns {Promise<{mode: string, count: number, files: {rel: string, count: number}[], skipped: number, kept: number, errors: string[], dryRun: boolean}>}
 */
async function applyToProject(mode, options = {}) {
    if (options.staged) {
        throw new Error('--staged only works with --check. Fix the working tree instead (e.g. --changed --fix).');
    }
    const { options: opts, files } = await scanProject(options);
    const summary = { mode, count: 0, files: [], skipped: 0, kept: 0, errors: [], dryRun: Boolean(options.dryRun) };

    for (const file of files) {
        if (file.error) {
            summary.errors.push(`${file.rel}: ${file.error}`);
        }
        summary.kept += file.kept;
        let edits;
        let count;
        if (mode === 'remove') {
            edits = planRemoval(file.text, file.calls);
        } else if (mode === 'comment') {
            const plan = planCommentOut(file.text, file.calls);
            edits = plan.edits;
            summary.skipped += plan.skipped.length;
        } else if (mode === 'keep') {
            edits = planKeep(file.text, file.calls, opts.ignoreComment || 'keep-log');
        } else if (mode === 'uncomment') {
            const plan = planUncomment(file.text, opts.methods, { fileName: file.path });
            edits = plan.edits;
            count = plan.count;
        } else {
            throw new Error(`Unknown mode: ${mode}`);
        }
        if (!edits.length) {
            continue;
        }
        count = count !== undefined ? count : new Set(edits.flatMap(e => e.calls || [])).size;
        if (!summary.dryRun) {
            fs.writeFileSync(file.path, applyEdits(file.text, edits));
        }
        summary.count += count;
        summary.files.push({ rel: file.rel, count });
    }
    return summary;
}

module.exports = {
    DEFAULTS,
    parseJsonc,
    readWorkspaceSettings,
    resolveOptions,
    collectFiles,
    scanProject,
    applyToProject
};
