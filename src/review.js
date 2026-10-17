const vscode = require('vscode');
const { isSupported, scanDocument, findTargetFiles, scanFiles } = require('./scanner');
const { runOnCalls } = require('./commands');

const ACTIONS = [
    { action: 'remove', iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove checked (Enter)' },
    { action: 'comment', iconPath: new vscode.ThemeIcon('comment'), tooltip: 'Comment out checked' },
    { action: 'keep', iconPath: new vscode.ThemeIcon('pass'), tooltip: 'Keep checked (add the ignore comment)' }
];
const GO_TO = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Go to this call' };

async function reveal(uri, call, preserveFocus) {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus });
    const range = new vscode.Range(document.positionAt(call.start), document.positionAt(call.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * A checklist of console calls. Everything starts checked: press Enter to
 * remove them all, or untick/filter first. The toggle-all checkbox applies to
 * the filtered items, so typing "debug" then toggling selects just those.
 * @param {'file'|'workspace'} scope
 */
async function review(scope = 'file') {
    let entries;
    if (scope === 'file') {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupported(editor.document)) {
            vscode.window.showWarningMessage('Open a JavaScript, TypeScript, Vue, Svelte, Astro or HTML file first.');
            return;
        }
        entries = [{ uri: editor.document.uri, result: scanDocument(editor.document) }];
    } else {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showWarningMessage('Open a folder or workspace first.');
            return;
        }
        entries = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Console Logs Remover', cancellable: true },
            async (progress, token) => {
                progress.report({ message: 'Finding files...' });
                return scanFiles(await findTargetFiles(undefined, token), { progress, token });
            }
        );
    }

    const items = [];
    let total = 0;
    for (const { uri, result } of entries) {
        const calls = result.calls.filter(c => !c.ignored);
        if (!calls.length) {
            continue;
        }
        if (scope === 'workspace') {
            items.push({ label: vscode.workspace.asRelativePath(uri), kind: vscode.QuickPickItemKind.Separator });
        }
        for (const call of calls) {
            items.push({
                label: call.snippet,
                description: `Ln ${call.line + 1}`,
                buttons: [GO_TO],
                picked: true,
                uri,
                call
            });
            total++;
        }
    }
    if (!total) {
        vscode.window.showInformationMessage(`No console calls found ${scope === 'file' ? 'in this file' : 'in the workspace'}.`);
        return;
    }

    const pick = vscode.window.createQuickPick();
    pick.title = `Console calls ${scope === 'file' ? 'in this file' : 'in the workspace'} (${total})`;
    pick.placeholder = 'Type to filter. Enter removes the checked calls; buttons above comment out or keep them.';
    pick.canSelectMany = true;
    pick.matchOnDescription = true;
    pick.ignoreFocusOut = true;
    pick.items = items;
    pick.selectedItems = items.filter(i => i.picked);
    pick.buttons = ACTIONS;

    pick.onDidChangeSelection(selected => {
        pick.title = `Console calls ${scope === 'file' ? 'in this file' : 'in the workspace'} (${selected.length} of ${total} checked)`;
    });
    pick.onDidTriggerItemButton(e => reveal(e.item.uri, e.item.call, true));
    if (scope === 'file') {
        pick.onDidChangeActive(([item]) => item && item.call && reveal(item.uri, item.call, true));
    }

    const action = await new Promise(resolve => {
        pick.onDidAccept(() => resolve('remove'));
        pick.onDidTriggerButton(button => resolve(button.action));
        pick.onDidHide(() => resolve(null));
        pick.show();
    });
    const selected = pick.selectedItems.filter(i => i.call);
    pick.dispose();

    if (action) {
        await runOnCalls(action, selected.map(i => ({ uri: i.uri, line: i.call.line, method: i.call.method })));
    }
}

module.exports = { review };
