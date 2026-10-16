const babel = require('@babel/parser');

const SCRIPT_EXTENSIONS = {
    js: 'jsx', jsx: 'jsx', mjs: 'jsx', cjs: 'jsx',
    ts: 'ts', mts: 'ts', cts: 'ts',
    tsx: 'tsx'
};
const EMBEDDED_EXTENSIONS = new Set(['vue', 'svelte', 'astro', 'html', 'htm']);
const LANGUAGE_IDS = {
    javascript: 'jsx',
    javascriptreact: 'jsx',
    typescript: 'ts',
    typescriptreact: 'tsx',
    vue: 'embedded',
    svelte: 'embedded',
    astro: 'embedded',
    html: 'embedded'
};
const SUPPORTED_LANGUAGE_IDS = Object.keys(LANGUAGE_IDS);

const SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/babel', 'text/typescript', 'ts']);

/**
 * Works out how a file should be parsed from its name, falling back to the
 * editor language id (for untitled documents).
 * @returns {'jsx'|'ts'|'tsx'|'embedded'|null}
 */
function fileKind(fileName, languageId) {
    const match = /\.([^./\\]+)$/.exec(fileName || '');
    const ext = match ? match[1].toLowerCase() : '';
    if (SCRIPT_EXTENSIONS[ext]) {
        return SCRIPT_EXTENSIONS[ext];
    }
    if (EMBEDDED_EXTENSIONS.has(ext)) {
        return 'embedded';
    }
    return LANGUAGE_IDS[languageId] || null;
}

/**
 * Returns the parts of a file that contain script code. Plain script files are
 * one region; Vue/Svelte/Astro/HTML files yield one region per <script> block
 * (plus Astro frontmatter).
 * @returns {{start: number, end: number, lang: 'jsx'|'ts'|'tsx'}[]}
 */
function scriptRegions(text, kind) {
    if (kind === 'jsx' || kind === 'ts' || kind === 'tsx') {
        return [{ start: 0, end: text.length, lang: kind }];
    }
    if (kind !== 'embedded') {
        return [];
    }

    const regions = [];
    const frontmatter = /^(\s*---\r?\n)([\s\S]*?)\r?\n---/.exec(text);
    if (frontmatter) {
        const start = frontmatter[1].length;
        regions.push({ start, end: start + frontmatter[2].length, lang: 'ts' });
    }

    const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let match;
    while ((match = scriptTag.exec(text))) {
        const attrs = match[1];
        const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs);
        if (type && !SCRIPT_TYPES.has(type[1].toLowerCase())) {
            continue;
        }
        const lang = /\blang\s*=\s*["']?(tsx)\b/i.test(attrs) ? 'tsx'
            : /\blang\s*=\s*["']?(ts|typescript)\b/i.test(attrs) ? 'ts'
                : 'jsx';
        const start = match.index + match[0].indexOf('>') + 1;
        regions.push({ start, end: start + match[2].length, lang });
    }
    return regions;
}

function pluginsFor(lang) {
    if (lang === 'ts') {
        return ['typescript', 'decorators-legacy'];
    }
    if (lang === 'tsx') {
        return ['typescript', 'jsx', 'decorators-legacy'];
    }
    return ['jsx', 'decorators-legacy'];
}

/**
 * Parses source code into a Babel AST. Throws on unrecoverable syntax errors.
 */
function parseCode(code, lang) {
    return babel.parse(code, {
        sourceType: 'unambiguous',
        plugins: pluginsFor(lang),
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        attachComment: false
    });
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'extra', 'comments', 'tokens',
    'leadingComments', 'trailingComments', 'innerComments', 'errors']);

/**
 * Depth-first walk over a Babel AST. The visitor receives
 * (node, parent, key, inArray) and may return false to skip the node's children.
 */
function walk(node, visitor, parent = null, key = null, inArray = false) {
    if (visitor(node, parent, key, inArray) === false) {
        return;
    }
    for (const childKey of Object.keys(node)) {
        if (SKIP_KEYS.has(childKey)) {
            continue;
        }
        const value = node[childKey];
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child.type === 'string') {
                    walk(child, visitor, node, childKey, true);
                }
            }
        } else if (value && typeof value.type === 'string') {
            walk(value, visitor, node, childKey, false);
        }
    }
}

module.exports = {
    SUPPORTED_LANGUAGE_IDS,
    fileKind,
    scriptRegions,
    parseCode,
    walk
};
