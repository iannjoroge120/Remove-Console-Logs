const vscode = require('vscode');
const path = require('path');
const { findConsoleCalls } = require('./core/finder');
const { fileKind } = require('./core/parse');
const { listNonIgnoredFiles } = require('./core/git');
const { getConfig } = require('./config');

const decoder = new TextDecoder('utf-8');

function isSupported(document) {
    return fileKind(document.fileName, document.languageId) !== null;
}

/** Current text of a file, preferring the open (possibly unsaved) document. */
async function readText(uri) {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

/**
 * Scans text for console calls using the settings that apply to `uri`.
 * Results for open documents are cached by version.
 */
const cache = new Map();

function scanText(uri, text, languageId, version, methods) {
    const key = uri.toString();
    const cached = cache.get(key);
    if (!methods && version !== undefined && cached && cached.version === version) {
        return cached.result;
    }
    const config = getConfig(uri);
    const result = findConsoleCalls(text, {
        fileName: uri.path,
        languageId,
        methods: methods || config.methods,
        ignoreComment: config.ignoreComment
    });
    if (!methods && version !== undefined) {
        cache.set(key, { version, result });
    }
    return result;
}

function scanDocument(document) {
    return scanText(document.uri, document.getText(), document.languageId, document.version);
}

function clearCache(uri) {
    if (uri) {
        cache.delete(uri.toString());
    } else {
        cache.clear();
    }
}

/**
 * Finds files to process under `base` (a folder URI) or every workspace
 * folder, honouring the include/exclude settings and .gitignore.
 * @returns {Promise<vscode.Uri[]>}
 */
async function findTargetFiles(base, token) {
    const roots = base ? [base] : (vscode.workspace.workspaceFolders || []).map(f => f.uri);
    const results = [];

    for (const root of roots) {
        const config = getConfig(root);
        const exclude = config.exclude.length ? `{${config.exclude.join(',')}}` : null;
        let uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, config.include), exclude, undefined, token);

        if (config.respectGitignore && root.scheme === 'file' && vscode.workspace.isTrusted) {
            const allowed = await listNonIgnoredFiles(root.fsPath).catch(() => null);
            if (allowed) {
                uris = uris.filter(uri => allowed.has(path.relative(root.fsPath, uri.fsPath)));
            }
        }
        results.push(...uris);
    }

    const seen = new Set();
    return results.filter(uri => {
        const key = uri.toString();
        return seen.has(key) ? false : (seen.add(key), true);
    });
}

/**
 * Reads and scans many files with a cancellable progress notification.
 * @returns {Promise<{uri: vscode.Uri, text: string, result: object}[]>}
 */
async function scanFiles(uris, { title, progress, token } = {}) {
    const scanned = [];
    const run = async (report, cancel) => {
        const increment = uris.length ? 100 / uris.length : 100;
        for (const uri of uris) {
            if (cancel && cancel.isCancellationRequested) {
                break;
            }
            report.report({ increment, message: vscode.workspace.asRelativePath(uri) });
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > getConfig(uri).maxFileSizeKB * 1024) {
                    continue;
                }
                const text = await readText(uri);
                const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                const result = open ? scanDocument(open) : scanText(uri, text);
                scanned.push({ uri, text, result });
            } catch (err) {
                scanned.push({ uri, text: '', result: { calls: [], error: err.message, supported: true } });
            }
        }
    };

    if (progress) {
        await run(progress, token);
    } else {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: title || 'Scanning for console calls', cancellable: true },
            (p, t) => run(p, t)
        );
    }
    return scanned;
}

module.exports = {
    isSupported,
    readText,
    scanText,
    scanDocument,
    clearCache,
    findTargetFiles,
    scanFiles
};
