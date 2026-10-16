const vscode = require('vscode');
const { DEFAULT_METHODS } = require('./core/finder');

const SECTION = 'consoleLogsRemover';

/**
 * Reads the extension settings, optionally scoped to a resource so that
 * folder-level settings in multi-root workspaces apply.
 */
function getConfig(scope) {
    const c = vscode.workspace.getConfiguration(SECTION, scope);
    return {
        methods: c.get('methods', DEFAULT_METHODS),
        include: c.get('include', '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,astro,html}'),
        exclude: c.get('exclude', []),
        respectGitignore: c.get('respectGitignore', true),
        ignoreComment: c.get('ignoreComment', 'keep-log'),
        preview: c.get('preview', 'multipleFiles'),
        saveAfterChange: c.get('saveAfterChange', false),
        maxFileSizeKB: c.get('maxFileSizeKB', 1024),
        diagnosticsSeverity: c.get('diagnostics.severity', 'hint'),
        statusBar: c.get('statusBar.enabled', true),
        insertLog: {
            prefix: c.get('insertLog.prefix', '🪵'),
            includeLocation: c.get('insertLog.includeLocation', true),
            quote: c.get('insertLog.quote', "'"),
            method: c.get('insertLog.method', 'log')
        }
    };
}

module.exports = { SECTION, getConfig };
