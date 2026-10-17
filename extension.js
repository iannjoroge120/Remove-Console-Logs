const vscode = require('vscode');
const { SUPPORTED_LANGUAGE_IDS } = require('./src/core/parse');
const { SECTION } = require('./src/config');
const { isSupported, clearCache, readText, scanText } = require('./src/scanner');
const { runOperation, undoLastOperation, undoAllOperations, showHistory, output } = require('./src/operations');
const commands = require('./src/commands');
const { insertLog } = require('./src/insertLog');
const { StatusBar } = require('./src/statusBar');
const { review } = require('./src/review');
const { registerTools } = require('./src/aiTools');
const { setupAi } = require('./src/aiSetup');
const { ConsoleDiagnostics, ConsoleCodeActions } = require('./src/diagnostics');
const { ConsoleTreeProvider } = require('./src/treeView');

function debounce(fn, ms) {
    const timers = new Map();
    return (key, ...args) => {
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            fn(...args);
        }, ms));
    };
}

/** Removes or comments out the calls behind a tree item (a file or one call). */
async function runOnTreeItem(mode, item) {
    if (!item) {
        return;
    }
    const text = await readText(item.uri);
    const result = scanText(item.uri, text);
    const filter = item.call
        ? call => call.line === item.call.line && call.method === item.call.method
        : undefined;
    await runOperation({ mode, files: [{ uri: item.uri, text, result, filter }], where: 'here' });
}

/**
 * Applies `mode` from the Console Logs view: to the checked items if there
 * are any, otherwise to everything listed.
 */
async function runFromView(tree, mode) {
    if (!tree.scanned) {
        await tree.refresh();
    }
    const checked = tree.checkedCalls();
    const items = checked.length ? checked : tree.allCalls();
    if (!items.length) {
        vscode.window.showInformationMessage('No console calls found in the workspace.');
        return;
    }
    const summary = await commands.runOnCalls(mode, items);
    if (summary && summary.count && checked.length) {
        tree.clearChecked();
    }
}

async function revealCall(item) {
    const document = await vscode.workspace.openTextDocument(item.uri);
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    const start = document.positionAt(item.call.start);
    const end = document.positionAt(item.call.end);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function activate(context) {
    const statusBar = new StatusBar();
    const diagnostics = new ConsoleDiagnostics();
    const tree = new ConsoleTreeProvider();
    const view = vscode.window.createTreeView('consoleLogsRemover.view', { treeDataProvider: tree, showCollapseAll: true, manageCheckboxStateManually: true });
    tree.attach(view);
    registerTools(context);

    vscode.commands.executeCommand('setContext', 'consoleLogsRemover.supportedLanguages', SUPPORTED_LANGUAGE_IDS);

    const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    register('consoleLogsRemover.removeFromFile', () => commands.inFile('remove'));
    register('consoleLogsRemover.removeFromSelection', () => commands.inSelection('remove'));
    register('consoleLogsRemover.removeFromWorkspace', () => commands.inWorkspace('remove'));
    register('consoleLogsRemover.removeFromExplorer', (uri, uris) => commands.inExplorerSelection('remove', uri, uris));
    register('consoleLogsRemover.removeFromChangedLines', () => commands.inChangedLines());
    register('consoleLogsRemover.removeInserted', () => commands.removeInserted());
    register('consoleLogsRemover.commentOutInFile', () => commands.inFile('comment'));
    register('consoleLogsRemover.commentOutInSelection', () => commands.inSelection('comment'));
    register('consoleLogsRemover.commentOutInWorkspace', () => commands.inWorkspace('comment'));
    register('consoleLogsRemover.uncommentInFile', () => commands.inFile('uncomment'));
    register('consoleLogsRemover.uncommentInWorkspace', () => commands.inWorkspace('uncomment'));
    register('consoleLogsRemover.insertLog', insertLog);
    register('consoleLogsRemover.undo', undoLastOperation);
    register('consoleLogsRemover.undoAll', undoAllOperations);
    register('consoleLogsRemover.showHistory', showHistory);
    register('consoleLogsRemover.showInFile', () => review('file'));
    register('consoleLogsRemover.review', () => review('workspace'));
    register('consoleLogsRemover.setupAi', setupAi);
    register('consoleLogsRemover.selectAll', () => tree.checkAll());
    register('consoleLogsRemover.clearSelection', () => tree.clearChecked());
    register('consoleLogsRemover.removeChecked', () => runFromView(tree, 'remove'));
    register('consoleLogsRemover.commentOutChecked', () => runFromView(tree, 'comment'));
    register('consoleLogsRemover.keepChecked', () => runFromView(tree, 'keep'));
    register('consoleLogsRemover.removeAllInView', () => runFromView(tree, 'remove'));
    register('consoleLogsRemover.commentOutAllInView', () => runFromView(tree, 'comment'));
    register('consoleLogsRemover.keepAllInView', () => runFromView(tree, 'keep'));
    register('consoleLogsRemover.keepTreeItem', item => runOnTreeItem('keep', item));
    register('consoleLogsRemover.showOutput', () => output.show());
    register('consoleLogsRemover.refreshView', () => tree.refresh());
    register('consoleLogsRemover.revealCall', revealCall);
    register('consoleLogsRemover.removeTreeItem', item => runOnTreeItem('remove', item));
    register('consoleLogsRemover.commentOutTreeItem', item => runOnTreeItem('comment', item));
    // Command id used before 1.0; kept so existing keybindings keep working.
    register('extension.removeConsoleLogs', () => commands.inWorkspace('remove'));

    const onDocumentChange = debounce(document => {
        diagnostics.update(document);
        tree.updateDocument(document);
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === document) {
            statusBar.update();
        }
    }, 300);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,astro,html,htm}');
    watcher.onDidCreate(uri => tree.updateUri(uri));
    watcher.onDidChange(uri => {
        if (!vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString())) {
            tree.updateUri(uri);
        }
    });
    watcher.onDidDelete(uri => {
        clearCache(uri);
        tree.removeUri(uri);
    });

    context.subscriptions.push(
        statusBar,
        diagnostics,
        view,
        watcher,
        output,
        vscode.languages.registerCodeActionsProvider(
            SUPPORTED_LANGUAGE_IDS.map(language => ({ language })),
            new ConsoleCodeActions(),
            ConsoleCodeActions.metadata
        ),
        vscode.window.onDidChangeActiveTextEditor(() => statusBar.update()),
        vscode.workspace.onDidOpenTextDocument(document => diagnostics.update(document)),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length && isSupported(event.document)) {
                onDocumentChange(event.document.uri.toString(), event.document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnostics.delete(document.uri);
            clearCache(document.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration(SECTION)) {
                return;
            }
            clearCache();
            diagnostics.refreshAll();
            statusBar.update();
            if (tree.scanned && ['methods', 'include', 'exclude', 'respectGitignore', 'ignoreComment']
                .some(key => event.affectsConfiguration(`${SECTION}.${key}`))) {
                tree.refresh();
            }
        })
    );

    vscode.workspace.textDocuments.forEach(document => diagnostics.update(document));
    statusBar.update();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
