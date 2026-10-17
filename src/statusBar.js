const vscode = require('vscode');
const { isSupported, scanDocument } = require('./scanner');
const { getConfig } = require('./config');

/**
 * Shows the number of console calls in the active file. Clicking it opens the
 * review checklist for the file.
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
        this.item.tooltip = `${calls.length} console call${calls.length === 1 ? '' : 's'} in this file. Click to review, remove, comment out or keep them.`;
        this.item.show();
    }

    dispose() {
        this.item.dispose();
    }
}

module.exports = { StatusBar };
