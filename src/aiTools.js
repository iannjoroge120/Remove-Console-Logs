const vscode = require('vscode');
const path = require('path');
const { findTargetFiles, scanFiles, readText, scanText } = require('./scanner');
const { collectChangedFiles } = require('./commands');
const { runOperation } = require('./operations');

/**
 * Language model tools so chat agents in VS Code (e.g. Copilot agent mode)
 * can find and clean up console calls with the extension's own engine,
 * settings and undo.
 */

const VERBS = { remove: 'Remove', comment: 'Comment out', keep: 'Keep', uncomment: 'Uncomment' };
const MAX_LISTED = 300;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function resolvePath(p) {
    if (path.isAbsolute(p)) {
        return vscode.Uri.file(p);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const uri = vscode.Uri.joinPath(folder.uri, p);
        try {
            await vscode.workspace.fs.stat(uri);
            return uri;
        } catch {
            // try the next folder
        }
    }
    throw new Error(`Could not find "${p}" in the workspace.`);
}

async function scanUri(uri, methods) {
    const text = await readText(uri);
    return { uri, text, result: scanText(uri, text, undefined, undefined, methods) };
}

/**
 * Turns tool input into the files (and per-file filters) to act on.
 * @returns {Promise<{files: object[], where: string}>}
 */
async function collectTargets(input, token) {
    const methods = input.methods && input.methods.length ? input.methods : undefined;

    if (input.locations && input.locations.length) {
        const byFile = new Map();
        for (const loc of input.locations) {
            const uri = await resolvePath(loc.path);
            const key = uri.toString();
            if (!byFile.has(key)) {
                byFile.set(key, { uri, lines: [] });
            }
            byFile.get(key).lines.push(Number(loc.line) - 1);
        }
        const files = [];
        for (const { uri, lines } of byFile.values()) {
            const file = await scanUri(uri, methods);
            file.filter = call => lines.some(line => line >= call.line && line <= call.endLine);
            files.push(file);
        }
        return { files, where: 'at the given locations' };
    }

    const scope = input.scope || (input.paths && input.paths.length ? 'workspace' : 'file');

    if (scope === 'changed') {
        return { files: await collectChangedFiles({ token, methods }), where: 'in lines changed since the last commit' };
    }

    if (scope === 'file' && !(input.paths && input.paths.length)) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No file is open in the editor. Pass "paths" or use scope "workspace".');
        }
        const document = editor.document;
        return {
            files: [{ uri: document.uri, text: document.getText(), result: scanText(document.uri, document.getText(), document.languageId, undefined, methods) }],
            where: `in ${vscode.workspace.asRelativePath(document.uri)}`
        };
    }

    let uris = [];
    if (input.paths && input.paths.length) {
        for (const p of input.paths) {
            const uri = await resolvePath(p);
            const stat = await vscode.workspace.fs.stat(uri);
            uris.push(...(stat.type & vscode.FileType.Directory ? await findTargetFiles(uri, token) : [uri]));
        }
    } else {
        uris = await findTargetFiles(undefined, token);
    }
    const scanned = await scanFiles(uris, { title: 'Scanning for console calls' });
    const files = methods ? await Promise.all(scanned.map(f => scanUri(f.uri, methods))) : scanned;
    return { files, where: input.paths && input.paths.length ? `in ${input.paths.join(', ')}` : 'in the workspace' };
}

function inScope(file) {
    return file.result.calls.filter(call => !call.ignored && (!file.filter || file.filter(call)));
}

const textResult = text => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

class FindTool {
    prepareInvocation() {
        return { invocationMessage: 'Finding console calls' };
    }

    async invoke(options, token) {
        const { files, where } = await collectTargets(options.input || {}, token);
        const lines = [];
        let total = 0;
        let fileCount = 0;
        let kept = 0;
        for (const file of files) {
            const calls = inScope(file);
            kept += file.result.calls.filter(c => c.ignored && (!file.filter || file.filter(c))).length;
            if (!calls.length) {
                continue;
            }
            fileCount++;
            for (const call of calls) {
                total++;
                if (lines.length < MAX_LISTED) {
                    lines.push(`${vscode.workspace.asRelativePath(file.uri)}:${call.line + 1}  ${call.snippet}`);
                }
            }
        }
        if (!total) {
            return textResult(`No console calls found ${where}.${kept ? ` (${kept} are marked to keep.)` : ''}`);
        }
        const header = `Found ${plural(total, 'console call')} in ${plural(fileCount, 'file')} ${where}:`;
        const more = total > lines.length ? `\n...and ${total - lines.length} more.` : '';
        const keptNote = kept ? `\n(${kept} more are marked with the keep comment and were excluded.)` : '';
        return textResult(`${header}\n${lines.join('\n')}${more}${keptNote}`);
    }
}

class ApplyTool {
    async prepareInvocation(options, token) {
        const input = options.input || {};
        const action = VERBS[input.action] ? input.action : 'remove';
        const { files, where } = await collectTargets(input, token);
        const count = files.reduce((n, f) => n + inScope(f).length, 0);
        const fileCount = files.filter(f => inScope(f).length).length;
        if (action !== 'uncomment' && !count) {
            return { invocationMessage: `No console calls to ${VERBS[action].toLowerCase()} ${where}` };
        }
        const what = action === 'uncomment' ? `commented-out console calls ${where}` : `**${plural(count, 'console call')}** in ${plural(fileCount, 'file')} ${where}`;
        return {
            invocationMessage: `${VERBS[action]} console calls ${where}`,
            confirmationMessages: {
                title: `${VERBS[action]} console calls?`,
                message: new vscode.MarkdownString(`${VERBS[action]} ${what}.\n\nYou can revert this with **Console Logs: Undo Last Change**.`)
            }
        };
    }

    async invoke(options, token) {
        const input = options.input || {};
        const action = input.action || 'remove';
        if (!VERBS[action]) {
            throw new Error(`Unknown action "${action}". Use remove, comment, keep or uncomment.`);
        }
        const { files, where } = await collectTargets(input, token);
        const summary = await runOperation({ mode: action, files, where, notify: false, preview: false });
        if (summary.count) {
            vscode.window.setStatusBarMessage(`$(debug-console) ${summary.message}`, 8000);
        }
        const details = summary.files.map(f => `- ${vscode.workspace.asRelativePath(f.uri)} (${f.count})`).join('\n');
        const undo = summary.count ? '\nThe user can revert this with the "Console Logs: Undo Last Change" command.' : '';
        const errors = summary.errors.length ? `\nCould not parse:\n${summary.errors.map(e => `- ${e}`).join('\n')}` : '';
        return textResult(`${summary.message}${details ? `\n${details}` : ''}${undo}${errors}`);
    }
}

function registerTools(context) {
    if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
        return;
    }
    context.subscriptions.push(
        vscode.lm.registerTool('consoleLogs_find', new FindTool()),
        vscode.lm.registerTool('consoleLogs_apply', new ApplyTool())
    );
}

module.exports = { registerTools, collectTargets };
