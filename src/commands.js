const vscode = require('vscode');
const { runOperation } = require('./operations');
const { isSupported, scanDocument, findTargetFiles, scanFiles, readText, scanText } = require('./scanner');
const { listChangedFiles, changedLines } = require('./core/git');
const { getConfig } = require('./config');

function activeSupportedEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
        vscode.window.showWarningMessage('Open a JavaScript, TypeScript, Vue, Svelte, Astro or HTML file first.');
        return null;
    }
    return editor;
}

function documentFile(document, filter) {
    return { uri: document.uri, text: document.getText(), result: scanDocument(document), filter };
}

/** Runs `mode` on the active file. */
async function inFile(mode) {
    const editor = activeSupportedEditor();
    if (editor) {
        await runOperation({ mode, files: [documentFile(editor.document)], where: 'in this file' });
    }
}

/** Runs `mode` on calls touching the selection(s), or the cursor line(s). */
async function inSelection(mode) {
    const editor = activeSupportedEditor();
    if (!editor) {
        return;
    }
    const ranges = editor.selections.map(s => [s.start.line, s.end.line]);
    const filter = call => ranges.some(([from, to]) => call.line <= to && call.endLine >= from);
    const where = editor.selections.some(s => !s.isEmpty) ? 'in the selection' : 'on the current line';
    await runOperation({ mode, files: [documentFile(editor.document, filter)], where });
}

/** Runs `mode` on every matching file in the workspace or under `folder`. */
async function inWorkspace(mode, folder, filter) {
    if (!folder && !vscode.workspace.workspaceFolders) {
        vscode.window.showWarningMessage('Open a folder or workspace first, or use the "in Current File" command.');
        return;
    }
    const files = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Console Logs Remover', cancellable: true },
        async (progress, token) => {
            progress.report({ message: 'Finding files...' });
            const uris = await findTargetFiles(folder, token);
            return scanFiles(uris, { progress, token });
        }
    );
    const where = folder ? `in ${vscode.workspace.asRelativePath(folder)}` : 'in the workspace';
    await runOperation({ mode, files: files.map(f => ({ ...f, filter })), where });
}

/** Explorer context menu: handles a mix of selected files and folders. */
async function inExplorerSelection(mode, clicked, selected) {
    const uris = selected && selected.length ? selected : clicked ? [clicked] : [];
    if (!uris.length) {
        return inWorkspace(mode);
    }
    const targets = [];
    for (const uri of uris) {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
            targets.push(...await findTargetFiles(uri));
        } else {
            targets.push(uri);
        }
    }
    const files = await scanFiles(targets, { title: 'Scanning for console calls' });
    const where = uris.length === 1 ? `in ${vscode.workspace.asRelativePath(uris[0])}` : 'in the selected items';
    await runOperation({ mode, files, where });
}

/** Removes console calls only on lines changed since the last commit. */
async function inChangedLines() {
    if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Git features are disabled in untrusted workspaces.');
        return;
    }
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
    if (!folders.length) {
        vscode.window.showWarningMessage('Open a folder that is a git repository first.');
        return;
    }

    const files = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Console Logs Remover', cancellable: true },
        async (progress, token) => {
            progress.report({ message: 'Asking git what changed...' });
            const candidates = new Set((await findTargetFiles(undefined, token)).map(u => u.fsPath));
            const changed = [];
            let anyRepo = false;
            for (const folder of folders) {
                const paths = await listChangedFiles(folder.uri.fsPath).catch(() => null);
                if (paths) {
                    anyRepo = true;
                    changed.push(...paths.filter(p => candidates.has(p)));
                }
            }
            if (!anyRepo) {
                return null;
            }
            const result = [];
            for (const fsPath of new Set(changed)) {
                if (token.isCancellationRequested) {
                    break;
                }
                const uri = vscode.Uri.file(fsPath);
                progress.report({ message: vscode.workspace.asRelativePath(uri) });
                const text = await readText(uri).catch(() => null);
                if (text === null) {
                    continue;
                }
                const lines = await changedLines(fsPath, text);
                const filter = call => {
                    for (let line = call.line; line <= call.endLine; line++) {
                        if (lines.has(line)) {
                            return true;
                        }
                    }
                    return false;
                };
                result.push({ uri, text, result: scanText(uri, text), filter });
            }
            return result;
        }
    );

    if (files === null) {
        vscode.window.showWarningMessage('No git repository found in this workspace.');
        return;
    }
    await runOperation({ mode: 'remove', files, where: 'in lines changed since the last commit' });
}

/** Removes only logs created by "Insert Log" (those starting with the prefix). */
async function removeInserted() {
    const prefix = getConfig().insertLog.prefix;
    if (!prefix) {
        vscode.window.showWarningMessage('Set "consoleLogsRemover.insertLog.prefix" to tag inserted logs first.');
        return;
    }
    await inWorkspace('remove', undefined, call => typeof call.firstArg === 'string' && call.firstArg.startsWith(prefix));
}

module.exports = {
    inFile,
    inSelection,
    inWorkspace,
    inExplorerSelection,
    inChangedLines,
    removeInserted,
    documentFile
};
