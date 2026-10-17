const vscode = require('vscode');
const { isSupported, scanDocument } = require('./scanner');
const { getConfig } = require('./config');
const { planRemoval, planCommentOut } = require('./core/transform');
const { LineIndex } = require('./core/text');

const SEVERITIES = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint
};
const DIAGNOSTIC_CODE = 'console-call';
// Skip read-only views such as git diffs and output panes.
const DIAGNOSTIC_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);
const SOURCE_KIND = vscode.CodeActionKind.Source.append('removeConsoleLogs');

/** Marks console calls in open files with diagnostics. */
class ConsoleDiagnostics {
    constructor() {
        this.collection = vscode.languages.createDiagnosticCollection('consoleLogsRemover');
    }

    update(document) {
        const severity = SEVERITIES[getConfig(document.uri).diagnosticsSeverity];
        if (severity === undefined || !DIAGNOSTIC_SCHEMES.has(document.uri.scheme) || !isSupported(document)) {
            this.collection.delete(document.uri);
            return;
        }
        const diagnostics = scanDocument(document).calls.filter(c => !c.ignored).map(call => {
            const range = new vscode.Range(document.positionAt(call.start), document.positionAt(call.end));
            const diagnostic = new vscode.Diagnostic(range, `console.${call.method} call`, severity);
            diagnostic.source = 'Console Logs Remover';
            diagnostic.code = DIAGNOSTIC_CODE;
            return diagnostic;
        });
        this.collection.set(document.uri, diagnostics);
    }

    delete(uri) {
        this.collection.delete(uri);
    }

    refreshAll() {
        this.collection.clear();
        vscode.workspace.textDocuments.forEach(d => this.update(d));
    }

    dispose() {
        this.collection.dispose();
    }
}

function toWorkspaceEdit(document, edits) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
        workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
    }
    return workspaceEdit;
}

/**
 * Quick Fixes on console calls, plus a `source.removeConsoleLogs` action that
 * can run on save via "editor.codeActionsOnSave".
 */
class ConsoleCodeActions {
    provideCodeActions(document, range, context) {
        const calls = scanDocument(document).calls.filter(c => !c.ignored);
        if (!calls.length) {
            return [];
        }
        const text = document.getText();
        const actions = [];

        if (!context.only || context.only.contains(SOURCE_KIND) || SOURCE_KIND.contains(context.only)) {
            const action = new vscode.CodeAction('Remove all console calls', SOURCE_KIND);
            action.edit = toWorkspaceEdit(document, planRemoval(text, calls));
            actions.push(action);
        }
        if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) {
            return actions;
        }

        const lines = new LineIndex(text);
        const startLine = range.start.line;
        const endLine = range.end.line;
        const here = calls.filter(c => c.line <= endLine && c.endLine >= startLine);
        const marker = getConfig(document.uri).ignoreComment;

        for (const call of here) {
            const name = `console.${call.method}`;
            const diagnostics = context.diagnostics.filter(d => d.code === DIAGNOSTIC_CODE && d.range.start.line === call.line);

            const remove = new vscode.CodeAction(`Remove ${name}`, vscode.CodeActionKind.QuickFix);
            remove.edit = toWorkspaceEdit(document, planRemoval(text, [call]));
            remove.diagnostics = diagnostics;
            remove.isPreferred = true;
            actions.push(remove);

            const commented = planCommentOut(text, [call]);
            if (commented.edits.length) {
                const comment = new vscode.CodeAction(`Comment out ${name}`, vscode.CodeActionKind.QuickFix);
                comment.edit = toWorkspaceEdit(document, commented.edits);
                comment.diagnostics = diagnostics;
                actions.push(comment);
            }

            if (marker) {
                const keep = new vscode.CodeAction(`Keep this ${name} (add // ${marker})`, vscode.CodeActionKind.QuickFix);
                const offset = lines.lineEnd(call.endLine);
                keep.edit = toWorkspaceEdit(document, [{ start: offset, end: offset, text: ` // ${marker}` }]);
                keep.diagnostics = diagnostics;
                actions.push(keep);
            }
        }

        if (calls.length > 1 && here.length) {
            const all = new vscode.CodeAction(`Remove all ${calls.length} console calls in file`, vscode.CodeActionKind.QuickFix);
            all.edit = toWorkspaceEdit(document, planRemoval(text, calls));
            actions.push(all);

            const reviewFile = new vscode.CodeAction('Review all console calls in file...', vscode.CodeActionKind.QuickFix);
            reviewFile.command = { command: 'consoleLogsRemover.showInFile', title: 'Review console calls' };
            actions.push(reviewFile);
        }
        if (here.length && vscode.workspace.workspaceFolders) {
            const workspaceAll = new vscode.CodeAction('Remove all console calls in workspace...', vscode.CodeActionKind.QuickFix);
            workspaceAll.command = { command: 'consoleLogsRemover.removeFromWorkspace', title: 'Remove console calls in workspace' };
            actions.push(workspaceAll);
        }
        return actions;
    }
}

ConsoleCodeActions.metadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, SOURCE_KIND]
};

module.exports = { ConsoleDiagnostics, ConsoleCodeActions };
