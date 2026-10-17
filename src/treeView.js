const vscode = require('vscode');
const path = require('path');
const { findTargetFiles, scanFiles, scanDocument, scanText, readText, isSupported } = require('./scanner');

/**
 * Sidebar view listing every console call in the workspace, grouped by file.
 * The workspace is scanned the first time the view is shown and kept up to
 * date as files change. Items have checkboxes so actions can be applied to
 * any selection, or to everything at once.
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
        /** Keys of checked calls, see callKey(). */
        this.checked = new Set();
    }

    attach(view) {
        this.view = view;
        view.onDidChangeCheckboxState(event => {
            for (const [item, state] of event.items) {
                const on = state === vscode.TreeItemCheckboxState.Checked;
                const calls = item instanceof FileItem ? item.calls.map(call => ({ uri: item.uri, call })) : [{ uri: item.uri, call: item.call }];
                for (const { uri, call } of calls) {
                    const key = callKey(uri, call);
                    if (on) {
                        this.checked.add(key);
                    } else {
                        this.checked.delete(key);
                    }
                }
            }
            this.changed();
        });
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
        // Drop checks for calls that no longer exist in this file.
        const prefix = uri.toString() + '|';
        const present = new Set(visible.map(call => callKey(uri, call)));
        for (const key of this.checked) {
            if (key.startsWith(prefix) && !present.has(key)) {
                this.checked.delete(key);
            }
        }
        if (visible.length) {
            this.files.set(uri.toString(), { uri, calls: visible });
        } else {
            this.files.delete(uri.toString());
        }
    }

    checkAll() {
        for (const { uri, calls } of this.files.values()) {
            calls.forEach(call => this.checked.add(callKey(uri, call)));
        }
        this.changed();
    }

    clearChecked() {
        this.checked.clear();
        this.changed();
    }

    /** @returns {{uri: vscode.Uri, line: number, method: string}[]} */
    allCalls() {
        const result = [];
        for (const { uri, calls } of this.files.values()) {
            calls.forEach(call => result.push({ uri, line: call.line, method: call.method }));
        }
        return result;
    }

    /** @returns {{uri: vscode.Uri, line: number, method: string}[]} */
    checkedCalls() {
        const result = [];
        for (const { uri, calls } of this.files.values()) {
            for (const call of calls) {
                if (this.checked.has(callKey(uri, call))) {
                    result.push({ uri, line: call.line, method: call.method });
                }
            }
        }
        return result;
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
        if (this.files.has(uri.toString())) {
            this.setFile(uri, []);
            this.changed();
        }
    }

    changed() {
        this._onDidChange.fire();
        if (this.view) {
            const total = [...this.files.values()].reduce((n, f) => n + f.calls.length, 0);
            this.view.badge = total ? { value: total, tooltip: `${total} console calls` } : undefined;
            this.view.message = this.scanned && !total ? 'No console calls found. Nice and clean!' : undefined;
            const selected = this.checkedCalls().length;
            this.view.description = selected ? `${selected} selected` : undefined;
            vscode.commands.executeCommand('setContext', 'consoleLogsRemover.hasChecked', selected > 0);
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
                .map(file => new FileItem(file.uri, file.calls, file.calls.every(call => this.checked.has(callKey(file.uri, call)))));
        }
        if (element instanceof FileItem) {
            return element.calls.map(call => new CallItem(element.uri, call, this.checked.has(callKey(element.uri, call))));
        }
        return [];
    }
}

const callKey = (uri, call) => `${uri.toString()}|${call.line}|${call.method}`;
const checkbox = checked => checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;

class FileItem extends vscode.TreeItem {
    constructor(uri, calls, checked = false) {
        super(uri, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = uri.toString();
        this.uri = uri;
        this.calls = calls;
        this.checkboxState = checkbox(checked);
        const dir = path.dirname(vscode.workspace.asRelativePath(uri));
        this.description = `${dir === '.' ? '' : dir + ' · '}${calls.length}`;
        this.contextValue = 'consoleLogsFile';
    }
}

class CallItem extends vscode.TreeItem {
    constructor(uri, call, checked = false) {
        super(call.snippet, vscode.TreeItemCollapsibleState.None);
        this.id = `${callKey(uri, call)}@${call.start}`;
        this.checkboxState = checkbox(checked);
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
