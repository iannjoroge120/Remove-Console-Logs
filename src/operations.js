const vscode = require('vscode');
const { LineIndex } = require('./core/text');
const { planRemoval, planCommentOut, planUncomment, planKeep } = require('./core/transform');
const { scanDocument } = require('./scanner');
const { getConfig } = require('./config');

const output = vscode.window.createOutputChannel('Console Logs Remover');

const MODES = {
    remove: { verb: 'Removed', label: call => `Remove console.${call.method}` },
    comment: { verb: 'Commented out', label: () => 'Comment out' },
    keep: { verb: 'Marked to keep', label: () => 'Keep (add ignore comment)' },
    uncomment: { verb: 'Restored', label: () => 'Uncomment' }
};

const MAX_HISTORY = 20;

/**
 * Changes made by the extension, newest last. Each file records the text
 * before and after, so a step can be undone only while the file still
 * matches what the extension left behind.
 * @type {{verb: string, count: number, files: {uri: vscode.Uri, original: string, after: string}[]}[]}
 */
const history = [];

function updateUndoContext() {
    vscode.commands.executeCommand('setContext', 'consoleLogsRemover.canUndo', history.length > 0);
    vscode.commands.executeCommand('setContext', 'consoleLogsRemover.canUndoAll', history.length > 1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const activeCount = result => result.calls.filter(call => !call.ignored).length;

/**
 * @typedef {Object} OperationSummary
 * @property {string} mode
 * @property {number} count               console calls changed
 * @property {{uri: vscode.Uri, count: number}[]} files
 * @property {number} kept                calls skipped because of the ignore comment
 * @property {number} skipped             calls that couldn't be commented out
 * @property {string[]} errors            files that couldn't be parsed
 * @property {string} message             human-readable summary
 */

/**
 * Plans and applies a change across one or more files as a single
 * WorkspaceEdit, then reports one summary with an Undo button.
 *
 * @param {Object} options
 * @param {'remove'|'comment'|'keep'|'uncomment'} options.mode
 * @param {{uri: vscode.Uri, text: string, result: object, filter?: (call: object) => boolean}[]} options.files
 * @param {string} options.where     e.g. "in this file", used in messages
 * @param {boolean} [options.quiet]  skip the "nothing found" message
 * @param {boolean} [options.notify] show notifications (false for AI tool calls)
 * @param {boolean} [options.preview] force the refactor preview on or off
 * @returns {Promise<OperationSummary>}
 */
async function runOperation({ mode, files, where, quiet = false, notify = true, preview }) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const touched = [];
    const errors = [];
    let skipped = 0;
    let kept = 0;
    let planned = 0;

    const multipleFiles = files.filter(f => f.result.calls.length || mode === 'uncomment').length > 1;
    const config = getConfig(files[0] && files[0].uri);
    const needsConfirmation = preview !== undefined ? preview
        : config.preview === 'always' || (config.preview === 'multipleFiles' && multipleFiles);

    for (const file of files) {
        if (file.result.error) {
            errors.push(`${vscode.workspace.asRelativePath(file.uri)}: ${file.result.error}`);
        }
        const inScope = file.result.calls.filter(call => !file.filter || file.filter(call));
        kept += inScope.filter(call => call.ignored).length;
        const calls = inScope.filter(call => !call.ignored);

        let edits;
        if (mode === 'remove') {
            edits = planRemoval(file.text, calls);
        } else if (mode === 'comment') {
            const plan = planCommentOut(file.text, calls);
            edits = plan.edits;
            skipped += plan.skipped.length;
        } else if (mode === 'keep') {
            edits = planKeep(file.text, calls, getConfig(file.uri).ignoreComment || 'keep-log');
        } else {
            edits = planUncomment(file.text, getConfig(file.uri).methods, { fileName: file.uri.path }).edits;
        }
        if (!edits.length) {
            continue;
        }

        const lines = new LineIndex(file.text);
        const toPosition = offset => {
            const p = lines.position(offset);
            return new vscode.Position(p.line, p.character);
        };
        for (const edit of edits) {
            const range = new vscode.Range(toPosition(edit.start), toPosition(edit.end));
            const metadata = {
                needsConfirmation,
                label: edit.call ? MODES[mode].label(edit.call) : MODES[mode].label(),
                description: edit.call ? `Ln ${edit.call.line + 1}: ${edit.call.snippet}` : undefined
            };
            workspaceEdit.replace(file.uri, range, edit.text, metadata);
        }
        planned += mode === 'uncomment' ? 1 : new Set(edits.flatMap(e => e.calls || [])).size;
        touched.push({ uri: file.uri, original: file.text, before: activeCount(file.result) });
    }

    if (errors.length) {
        output.appendLine(`[${new Date().toLocaleTimeString()}] Files that could not be parsed:`);
        errors.forEach(e => output.appendLine(`  ${e}`));
    }

    const summary = { mode, count: 0, files: [], kept, skipped, errors, message: '' };

    if (!planned) {
        const noun = mode === 'uncomment' ? 'commented-out console calls' : 'console calls';
        const extra = kept ? ` (${plural(kept, 'call')} kept by the ignore comment)` : skipped ? ` (${skipped} share a line with other code and can't be commented out)` : '';
        summary.message = `No ${noun} found ${where}${extra}.`;
        if (notify && !quiet) {
            vscode.window.showInformationMessage(summary.message);
        }
        return summary;
    }

    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
        summary.message = 'The change was cancelled.';
        return summary;
    }

    // Work out what actually changed: the preview lets people untick edits.
    const changed = [];
    for (const file of touched) {
        const document = await vscode.workspace.openTextDocument(file.uri);
        if (document.getText() === file.original) {
            continue;
        }
        const after = activeCount(scanDocument(document));
        const count = mode === 'uncomment' ? Math.max(0, after - file.before) : Math.max(0, file.before - after);
        summary.count += count;
        summary.files.push({ uri: file.uri, count });
        changed.push({ uri: file.uri, original: file.original, document });
    }
    if (!changed.length) {
        summary.message = 'Nothing was changed.';
        return summary;
    }

    if (config.saveAfterChange) {
        await Promise.all(changed.map(f => f.document.save()));
    }

    history.push({
        verb: MODES[mode].verb,
        count: summary.count,
        files: changed.map(f => ({ uri: f.uri, original: f.original, after: f.document.getText() }))
    });
    if (history.length > MAX_HISTORY) {
        history.shift();
    }
    updateUndoContext();

    const notes = [];
    if (kept) {
        notes.push(`${kept} kept by ignore comment`);
    }
    if (skipped) {
        notes.push(`${skipped} skipped (share a line with other code)`);
    }
    if (errors.length) {
        notes.push(`${plural(errors.length, 'file')} couldn't be parsed`);
    }
    summary.message = `${MODES[mode].verb} ${plural(summary.count, 'console call')}${changed.length > 1 ? ` in ${changed.length} files` : ''}.`
        + (notes.length ? ` (${notes.join('; ')})` : '');

    if (notify) {
        const actions = ['Undo'].concat(history.length > 1 ? ['Undo All'] : [], errors.length ? ['Show Details'] : []);
        vscode.window.showInformationMessage(summary.message, ...actions).then(choice => {
            if (choice === 'Undo') {
                undoLastOperation();
            } else if (choice === 'Undo All') {
                undoAllOperations();
            } else if (choice === 'Show Details') {
                output.show();
            }
        });
    }
    return summary;
}

/**
 * Reverts history entries, newest first. A file is restored only if its text
 * still matches what the extension left, so later edits are never lost.
 * @returns {Promise<{steps: number, files: number, stale: number}>}
 */
async function revert(entries) {
    const result = { steps: 0, files: 0, stale: 0 };
    const restored = new Map();
    for (const entry of entries) {
        const edit = new vscode.WorkspaceEdit();
        let any = false;
        for (const file of entry.files) {
            const document = await vscode.workspace.openTextDocument(file.uri);
            if (document.getText() !== file.after) {
                result.stale++;
                continue;
            }
            const end = document.lineAt(document.lineCount - 1).range.end;
            edit.replace(file.uri, new vscode.Range(new vscode.Position(0, 0), end), file.original);
            restored.set(file.uri.toString(), document);
            any = true;
        }
        if (any) {
            if (!(await vscode.workspace.applyEdit(edit))) {
                throw new Error('Could not undo the change.');
            }
            result.steps++;
        }
        history.splice(history.indexOf(entry), 1);
    }
    result.files = restored.size;
    const docs = [...restored.values()];
    if (docs.length && getConfig(docs[0].uri).saveAfterChange) {
        await Promise.all(docs.map(d => d.save()));
    }
    updateUndoContext();
    return result;
}

function reportUndo(label, { files, stale }) {
    const staleNote = stale ? ` ${plural(stale, 'file')} changed since and ${stale === 1 ? 'was' : 'were'} left as is (use Ctrl/Cmd+Z there).` : '';
    const message = files ? `Undid ${label} in ${plural(files, 'file')}.${staleNote}` : `Nothing could be undone.${staleNote}`;
    (stale ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message);
}

/** Undoes the most recent change. */
async function undoLastOperation() {
    if (!history.length) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
    }
    const entry = history[history.length - 1];
    try {
        reportUndo(`"${entry.verb.toLowerCase()}"`, await revert([entry]));
    } catch (err) {
        vscode.window.showErrorMessage(err.message);
    }
}

/** Undoes every change the extension has made this session, newest first. */
async function undoAllOperations() {
    if (!history.length) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
    }
    const steps = history.length;
    try {
        reportUndo(`${plural(steps, 'change')}`, await revert(history.slice().reverse()));
    } catch (err) {
        vscode.window.showErrorMessage(err.message);
    }
}

/** Shows the change history; picking an entry undoes it and everything after it. */
async function showHistory() {
    if (!history.length) {
        vscode.window.showInformationMessage('No changes to undo.');
        return;
    }
    const newestFirst = history.slice().reverse();
    const items = newestFirst.map((entry, i) => ({
        label: `$(discard) ${entry.verb} ${plural(entry.count, 'console call')}`,
        description: entry.files.length === 1 ? vscode.workspace.asRelativePath(entry.files[0].uri) : plural(entry.files.length, 'file'),
        detail: i === 0 ? 'Undo the most recent change' : `Undo this and the ${plural(i, 'newer change')} above it`,
        steps: i + 1
    }));
    if (history.length > 1) {
        items.unshift({ label: `$(clear-all) Undo all ${history.length} changes`, steps: history.length }, { label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    const choice = await vscode.window.showQuickPick(items, { title: 'Console Logs: Change History', placeHolder: 'Pick how far back to undo' });
    if (!choice) {
        return;
    }
    try {
        reportUndo(plural(choice.steps, 'change'), await revert(newestFirst.slice(0, choice.steps)));
    } catch (err) {
        vscode.window.showErrorMessage(err.message);
    }
}

/** Lists the undo history so a person can see what the extension (or an AI agent) changed. */
function historySummary() {
    return history.slice().reverse().map(entry => ({
        verb: entry.verb,
        count: entry.count,
        files: entry.files.map(f => f.uri)
    }));
}

module.exports = { runOperation, undoLastOperation, undoAllOperations, showHistory, historySummary, output, MODES };
