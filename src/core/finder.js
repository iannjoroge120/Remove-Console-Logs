const { fileKind, scriptRegions, parseCode, walk } = require('./parse');
const { LineIndex } = require('./text');

const DEFAULT_METHODS = ['log', 'debug', 'info', 'trace', 'table', 'dir', 'dirxml',
    'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'group', 'groupCollapsed', 'groupEnd'];
const ALL_METHODS = DEFAULT_METHODS.concat(['warn', 'error', 'assert', 'clear', 'profile', 'profileEnd', 'timeStamp']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'global']);
const FUNCTION_TYPES = new Set(['ArrowFunctionExpression']);

/**
 * @typedef {Object} ConsoleCall
 * @property {string} method          e.g. "log"
 * @property {number} start           offset of the call expression
 * @property {number} end
 * @property {number} stmtStart       offset of the enclosing statement (same as start when not a statement)
 * @property {number} stmtEnd
 * @property {'statement'|'sole-body'|'arrow-body'|'expression'} context
 * @property {boolean} parenthesized  arrow body wrapped in parentheses
 * @property {number} line            0-based line of the call
 * @property {number} endLine
 * @property {boolean} ignored        marked with the ignore comment
 * @property {string|null} firstArg   value of a leading string argument, if any
 * @property {string} snippet         single-line preview of the call
 */

function memberName(node) {
    if (!node.computed && node.property.type === 'Identifier') {
        return node.property.name;
    }
    if (node.computed && node.property.type === 'StringLiteral') {
        return node.property.value;
    }
    return null;
}

function isMember(node) {
    return node && (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression');
}

/** Returns the console method name if `node` is a call like console.log(...), else null. */
function consoleMethod(node) {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
        return null;
    }
    const callee = node.callee;
    if (!isMember(callee)) {
        return null;
    }
    const object = callee.object;
    const isConsole = (object.type === 'Identifier' && object.name === 'console')
        || (isMember(object) && memberName(object) === 'console'
            && object.object.type === 'Identifier' && GLOBAL_OBJECTS.has(object.object.name));
    return isConsole ? memberName(callee) : null;
}

function firstStringArg(node) {
    const arg = node.arguments[0];
    if (!arg) {
        return null;
    }
    if (arg.type === 'StringLiteral') {
        return arg.value;
    }
    if (arg.type === 'TemplateLiteral' && arg.quasis.length > 0) {
        return arg.quasis[0].value.cooked || '';
    }
    return null;
}

function isIgnored(lines, startLine, endLine, marker) {
    if (!marker) {
        return false;
    }
    if (lines.lineText(startLine).includes(marker) || lines.lineText(endLine).includes(marker)) {
        return true;
    }
    if (startLine > 0) {
        const previous = lines.lineText(startLine - 1).trim();
        return (previous.startsWith('//') || previous.startsWith('/*') || previous.startsWith('*'))
            && previous.includes(marker);
    }
    return false;
}

/**
 * Finds console calls in a file.
 * @param {string} text
 * @param {{fileName?: string, languageId?: string, methods?: string[], ignoreComment?: string}} options
 * @returns {{calls: ConsoleCall[], error: string|null, supported: boolean}}
 */
function findConsoleCalls(text, options = {}) {
    const kind = fileKind(options.fileName, options.languageId);
    if (!kind) {
        return { calls: [], error: null, supported: false };
    }
    const methods = new Set(options.methods || DEFAULT_METHODS);
    const marker = options.ignoreComment === undefined ? 'keep-log' : options.ignoreComment;
    const lines = new LineIndex(text);
    const calls = [];
    const errors = [];

    for (const region of scriptRegions(text, kind)) {
        const code = text.slice(region.start, region.end);
        if (!code.includes('console')) {
            continue;
        }
        let ast;
        try {
            ast = parseCode(code, region.lang);
        } catch (err) {
            errors.push(err.message);
            continue;
        }

        const parents = new Map();
        walk(ast.program, (node, parent, key, inArray) => {
            parents.set(node, { parent, key, inArray });
            const method = consoleMethod(node);
            if (!method) {
                return true;
            }
            if (methods.has(method)) {
                calls.push(describeCall(node, method, parents, region.start, lines, marker));
            }
            // Calls nested inside a console call disappear with it.
            return false;
        });
    }

    calls.sort((a, b) => a.start - b.start);
    return { calls, error: errors.length ? errors.join('; ') : null, supported: true };
}

function describeCall(node, method, parents, offset, lines, marker) {
    const info = parents.get(node);
    let context = 'expression';
    let stmt = null;

    if (info.parent && info.parent.type === 'ExpressionStatement') {
        stmt = info.parent;
    } else if (info.parent && info.parent.type === 'LogicalExpression' && info.key === 'right') {
        // `debug && console.log(x);` goes away as a whole statement.
        const outer = parents.get(info.parent);
        if (outer.parent && outer.parent.type === 'ExpressionStatement') {
            stmt = outer.parent;
        }
    }

    if (stmt) {
        context = parents.get(stmt).inArray ? 'statement' : 'sole-body';
    } else if (info.parent && FUNCTION_TYPES.has(info.parent.type) && info.key === 'body') {
        context = 'arrow-body';
    }

    const start = node.start + offset;
    const end = node.end + offset;
    const stmtStart = stmt ? stmt.start + offset : start;
    const stmtEnd = stmt ? stmt.end + offset : end;
    const line = lines.lineAt(stmtStart);
    const endLine = lines.lineAt(stmtEnd);
    const source = lines.text.slice(start, end).replace(/\s+/g, ' ');

    return {
        method,
        start,
        end,
        stmtStart,
        stmtEnd,
        context,
        parenthesized: Boolean(node.extra && node.extra.parenthesized),
        line: lines.lineAt(start),
        endLine,
        ignored: isIgnored(lines, line, endLine, marker),
        firstArg: firstStringArg(node),
        snippet: source.length > 80 ? source.slice(0, 77) + '...' : source
    };
}

module.exports = {
    DEFAULT_METHODS,
    ALL_METHODS,
    findConsoleCalls,
    consoleMethod
};
