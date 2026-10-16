const vscode = require('vscode');
const path = require('path');
const { findTargetFiles, scanFiles, scanDocument, scanText, readText, isSupported } = require('./scanner');

/**
 * Sidebar view listing every console call in the workspace, grouped by file.
 * The workspace is scanned the first time the view is shown and kept up to
 * date as files change.
 */
class ConsoleTreeProvider {
    constructor() {
        /** @type {Map<string, {uri: vscode.Uri, calls: object[]}>} */
        this.files = new Map();
        this.scanned = false;
        this.scanning = null;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChange.event;
        this.view = null;
    }

    attach(view) {
        this.view = view;
        view.onDidChangeVisibility(() => {
            if (view.visible && !this.scanned) {
                this.refresh();
            }
        });
    }

    async refresh() {
        if (this.scanning) {
            return this.scanning;
        }
        this.scanning = (async () => {
            const uris = await findTargetFiles();
            const scanned = await scanFiles(uris, { title: 'Scanning workspace for console calls' });
            this.files.clear();
            for (const { uri, result } of scanned) {
                this.setFile(uri, result.calls);
            }
            this.scanned = true;
            this.changed();
        })().finally(() => {
            this.scanning = null;
        });
        return this.scanning;
    }

    setFile(uri, calls) {
        const visible = calls.filter(c => !c.ignored);
        if (visible.length) {
            this.files.set(uri.toString(), { uri, calls: visible });
        } else {
            this.files.delete(uri.toString());
        }
    }

    /** Re-scans one document after an edit or save. */
    updateDocument(document) {
        if (!this.scanned || !isSupported(document) || !vscode.workspace.getWorkspaceFolder(document.uri)) {
            return;
        }
        const key = document.uri.toString();
        const result = scanDocument(document);
        const had = this.files.has(key);
        if (!had && !result.calls.length) {
            return;
        }
        // Only track files that the workspace scan would include.
        if (!had) {
            findTargetFiles(vscode.workspace.getWorkspaceFolder(document.uri).uri).then(uris => {
                if (uris.some(u => u.toString() === key)) {
                    this.setFile(document.uri, result.calls);
                    this.changed();
                }
            });
            return;
        }
        this.setFile(document.uri, result.calls);
        this.changed();
    }

    async updateUri(uri) {
        if (!this.scanned) {
            return;
        }
        try {
            const text = await readText(uri);
            this.setFile(uri, scanText(uri, text).calls);
        } catch {
            this.files.delete(uri.toString());
        }
        this.changed();
    }

    removeUri(uri) {
        if (this.files.delete(uri.toString())) {
            this.changed();
        }
    }

    changed() {
        this._onDidChange.fire();
        if (this.view) {
            const total = [...this.files.values()].reduce((n, f) => n + f.calls.length, 0);
            this.view.badge = total ? { value: total, tooltip: `${total} console calls` } : undefined;
            this.view.message = this.scanned && !total ? 'No console calls found. Nice and clean!' : undefined;
        }
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            if (!this.scanned) {
                this.refresh();
                return [];
            }
            return [...this.files.values()]
                .sort((a, b) => a.uri.path.localeCompare(b.uri.path))
                .map(file => new FileItem(file.uri, file.calls));
        }
        if (element instanceof FileItem) {
            return element.calls.map(call => new CallItem(element.uri, call));
        }
        return [];
    }
}

class FileItem extends vscode.TreeItem {
    constructor(uri, calls) {
        super(uri, vscode.TreeItemCollapsibleState.Collapsed);
        this.uri = uri;
        this.calls = calls;
        const dir = path.dirname(vscode.workspace.asRelativePath(uri));
        this.description = `${dir === '.' ? '' : dir + ' · '}${calls.length}`;
        this.contextValue = 'consoleLogsFile';
    }
}

class CallItem extends vscode.TreeItem {
    constructor(uri, call) {
        super(call.snippet, vscode.TreeItemCollapsibleState.None);
        this.uri = uri;
        this.call = call;
        this.description = `Ln ${call.line + 1}`;
        this.tooltip = `${vscode.workspace.asRelativePath(uri)}:${call.line + 1}\n${call.snippet}`;
        this.iconPath = new vscode.ThemeIcon(call.method === 'error' ? 'error' : call.method === 'warn' ? 'warning' : 'debug-console');
        this.contextValue = 'consoleLogsCall';
        this.command = { command: 'consoleLogsRemover.revealCall', title: 'Go to console call', arguments: [this] };
    }
}

module.exports = { ConsoleTreeProvider, FileItem, CallItem };
