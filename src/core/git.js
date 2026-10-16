const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs git and resolves with stdout. Exit code 1 is treated as success for
 * commands like `diff --no-index` that use it to mean "differences found".
 */
function git(args, cwd, { allowExitOne = false } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => {
            if (err && !(allowExitOne && err.code === 1)) {
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

async function isGitRepo(cwd) {
    try {
        return (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true';
    } catch {
        return false;
    }
}

const splitZ = out => out.split('\0').filter(Boolean);

/**
 * Files git doesn't ignore (tracked + untracked), as paths relative to `cwd`.
 * @returns {Promise<Set<string>|null>} null when `cwd` isn't in a git repo
 */
async function listNonIgnoredFiles(cwd) {
    if (!(await isGitRepo(cwd))) {
        return null;
    }
    const out = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd);
    return new Set(splitZ(out).map(p => path.normalize(p)));
}

/**
 * Absolute paths of files changed since HEAD (staged, unstaged or untracked).
 * @returns {Promise<string[]|null>} null when `cwd` isn't in a git repo
 */
async function listChangedFiles(cwd) {
    if (!(await isGitRepo(cwd))) {
        return null;
    }
    const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    let changed;
    try {
        changed = splitZ(await git(['diff', '--name-only', '-z', 'HEAD'], root));
    } catch {
        // No commits yet: everything that's tracked counts as changed.
        changed = splitZ(await git(['ls-files', '-z'], root));
    }
    const untracked = splitZ(await git(['ls-files', '-z', '--others', '--exclude-standard'], root));
    return [...new Set(changed.concat(untracked))].map(p => path.join(root, p));
}

/** Content of a file at HEAD, or '' if it doesn't exist there. */
async function headContent(filePath) {
    const cwd = path.dirname(filePath);
    try {
        const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        return await git(['show', `HEAD:${rel}`], root);
    } catch {
        return '';
    }
}

/**
 * 0-based line numbers in `newText` that were added or modified relative to
 * the file's HEAD version. Uses the in-editor text so unsaved edits count.
 * @returns {Promise<Set<number>>}
 */
async function changedLines(filePath, newText) {
    const oldText = await headContent(filePath);
    if (!oldText) {
        return allLines(newText);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-logs-remover-'));
    try {
        const a = path.join(dir, 'a');
        const b = path.join(dir, 'b');
        fs.writeFileSync(a, oldText);
        fs.writeFileSync(b, newText);
        const diff = await git(['diff', '--no-index', '--no-color', '--ignore-cr-at-eol', '-U0', a, b], dir, { allowExitOne: true });
        return parseAddedLines(diff);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function allLines(text) {
    const count = text.split('\n').length;
    return new Set(Array.from({ length: count }, (_, i) => i));
}

/** Parses `@@ -a,b +c,d @@` hunk headers into 0-based added line numbers. */
function parseAddedLines(diff) {
    const lines = new Set();
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match;
    while ((match = hunk.exec(diff))) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let i = 0; i < count; i++) {
            lines.add(start - 1 + i);
        }
    }
    return lines;
}

module.exports = {
    isGitRepo,
    listNonIgnoredFiles,
    listChangedFiles,
    changedLines,
    parseAddedLines
};
