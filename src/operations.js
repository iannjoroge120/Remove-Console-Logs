const vscode = require('vscode');
const { LineIndex } = require('./core/text');
const { planRemoval, planCommentOut, planUncomment } = require('./core/transform');
const { scanDocument } = require('./scanner');
const { getConfig } = require('./config');

const output = vscode.window.createOutputChannel('Console Logs Remover');

const MODES = {
    remove: { verb: 'Removed', label: call => `Remove console.${call.method}` },
    comment: { verb: 'Commented out', label: () => 'Comment out' },
    uncomment: { verb: 'Restored', label: () => 'Uncomment' }
};

/** @type {{files: {uri: vscode.Uri, original: string, version: number}[], verb: string}|null} */
let lastOperation = null;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Plans and applies a change across one or more files as a single
 * WorkspaceEdit, then reports one summary with an Undo button.
 *
 * @param {Object} options
 * @param {'remove'|'comment'|'uncomment'} options.mode
 * @param {{uri: vscode.Uri, text: string, result: object, filter?: (call: object) => boolean}[]} options.files
 * @param {string} options.where   e.g. "in this file", used in messages
 * @param {boolean} [options.quiet] skip the "nothing found" message
 * @returns {Promise<boolean>} whether anything changed
 */
async function runOperation({ mode, files, where, quiet = false }) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const touched = [];
    const errors = [];
    let skipped = 0;
    let kept = 0;
    let planned = 0;

    const multipleFiles = files.filter(f => f.result.calls.length || mode === 'uncomment').length > 1;
    const config = getConfig(files[0] && files[0].uri);
    const needsConfirmation = config.preview === 'always' || (config.preview === 'multipleFiles' && multipleFiles);

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
        touched.push({ uri: file.uri, original: file.text, before: file.result.calls.length });
    }

    if (errors.length) {
        output.appendLine(`[${new Date().toLocaleTimeString()}] Files that could not be parsed:`);
        errors.forEach(e => output.appendLine(`  ${e}`));
    }

    if (!planned) {
        if (!quiet) {
            const noun = mode === 'uncomment' ? 'commented-out console calls' : 'console calls';
            const extra = kept ? ` (${plural(kept, 'call')} kept by the ignore comment)` : skipped ? ` (${skipped} share a line with other code and can't be commented out)` : '';
            vscode.window.showInformationMessage(`No ${noun} found ${where}${extra}.`);
        }
        return false;
    }

    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
        return false;
    }

    // Work out what actually changed: the preview lets people untick edits.
    const changed = [];
    let count = 0;
    for (const file of touched) {
        const document = await vscode.workspace.openTextDocument(file.uri);
        if (document.getText() === file.original) {
            continue;
        }
        const after = scanDocument(document).calls.length;
        count += mode === 'uncomment' ? Math.max(0, after - file.before) : Math.max(0, file.before - after);
        changed.push({ uri: file.uri, original: file.original, document });
    }
    if (!changed.length) {
        return false;
    }

    if (config.saveAfterChange) {
        await Promise.all(changed.map(f => f.document.save()));
    }

    lastOperation = {
        verb: MODES[mode].verb,
        files: changed.map(f => ({ uri: f.uri, original: f.original, version: f.document.version }))
    };
    vscode.commands.executeCommand('setContext', 'consoleLogsRemover.canUndo', true);

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
    const message = `${MODES[mode].verb} ${plural(count, 'console call')}${changed.length > 1 ? ` in ${changed.length} files` : ''}.`
        + (notes.length ? ` (${notes.join('; ')})` : '');
    const actions = ['Undo'].concat(errors.length ? ['Show Details'] : []);
    vscode.window.showInformationMessage(message, ...actions).then(choice => {
        if (choice === 'Undo') {
            undoLastOperation();
        } else if (choice === 'Show Details') {
            output.show();
        }
    });
    return true;
}

/**
 * Restores the files touched by the last operation. Files edited since then
 * are left alone so later work is never overwritten.
 */
async function undoLastOperation() {
    if (!lastOperation) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
    }
    const { files, verb } = lastOperation;
    const edit = new vscode.WorkspaceEdit();
    const restored = [];
    let stale = 0;

    for (const file of files) {
        const document = await vscode.workspace.openTextDocument(file.uri);
        if (document.version !== file.version) {
            stale++;
            continue;
        }
        const end = document.lineAt(document.lineCount - 1).range.end;
        edit.replace(file.uri, new vscode.Range(new vscode.Position(0, 0), end), file.original);
        restored.push(document);
    }

    if (restored.length && !(await vscode.workspace.applyEdit(edit))) {
        vscode.window.showErrorMessage('Could not undo the last change.');
        return;
    }
    lastOperation = null;
    vscode.commands.executeCommand('setContext', 'consoleLogsRemover.canUndo', false);

    if (getConfig(restored[0] && restored[0].uri).saveAfterChange) {
        await Promise.all(restored.map(d => d.save()));
    }

    const what = verb.toLowerCase();
    if (stale) {
        vscode.window.showWarningMessage(`Undid "${what}" in ${plural(restored.length, 'file')}. ${plural(stale, 'file')} changed since and ${stale === 1 ? 'was' : 'were'} left as is (use Ctrl/Cmd+Z there).`);
    } else {
        vscode.window.showInformationMessage(`Undid "${what}" in ${plural(restored.length, 'file')}.`);
    }
}

module.exports = { runOperation, undoLastOperation, output };
