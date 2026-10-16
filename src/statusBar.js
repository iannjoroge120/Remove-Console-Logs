const vscode = require('vscode');
const { isSupported, scanDocument } = require('./scanner');
const { getConfig } = require('./config');
const { runOperation } = require('./operations');
const { documentFile } = require('./commands');

/**
 * Shows the number of console calls in the active file. Clicking it opens a
 * quick pick to jump to each call or remove/comment them all.
 */
class StatusBar {
    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'consoleLogsRemover.showInFile';
        this.item.name = 'Console Logs';
    }

    update() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupported(editor.document) || !getConfig(editor.document.uri).statusBar) {
            this.item.hide();
            return;
        }
        const calls = scanDocument(editor.document).calls.filter(c => !c.ignored);
        if (!calls.length) {
            this.item.hide();
            return;
        }
        this.item.text = `$(debug-console) ${calls.length}`;
        this.item.tooltip = `${calls.length} console call${calls.length === 1 ? '' : 's'} in this file. Click to review or remove.`;
        this.item.show();
    }

    dispose() {
        this.item.dispose();
    }
}

/** Quick pick listing the console calls in the active file. */
async function showInFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
        return;
    }
    const document = editor.document;
    const calls = scanDocument(document).calls.filter(c => !c.ignored);
    const original = editor.selection;

    const actions = calls.length ? [
        { label: `$(trash) Remove all ${calls.length} from this file`, action: 'remove' },
        { label: '$(comment) Comment out all in this file', action: 'comment' },
        { label: '', kind: vscode.QuickPickItemKind.Separator }
    ] : [];
    const items = actions.concat(calls.map(call => ({
        label: call.snippet,
        description: `Ln ${call.line + 1}`,
        call
    })));
    if (!calls.length) {
        items.push({ label: '$(check) No console calls in this file', action: 'none' });
    }

    const pick = vscode.window.createQuickPick();
    pick.items = items;
    pick.placeholder = 'Jump to a console call, or remove them all';
    pick.matchOnDescription = true;

    const reveal = call => {
        const range = new vscode.Range(document.positionAt(call.start), document.positionAt(call.end));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    };
    pick.onDidChangeActive(([item]) => item && item.call && reveal(item.call));

    const chosen = await new Promise(resolve => {
        pick.onDidAccept(() => resolve(pick.selectedItems[0]));
        pick.onDidHide(() => resolve(undefined));
        pick.show();
    });
    pick.dispose();

    if (!chosen) {
        editor.selection = original;
        editor.revealRange(original, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } else if (chosen.action === 'remove' || chosen.action === 'comment') {
        await runOperation({ mode: chosen.action, files: [documentFile(document)], where: 'in this file' });
    }
}

module.exports = { StatusBar, showInFile };
