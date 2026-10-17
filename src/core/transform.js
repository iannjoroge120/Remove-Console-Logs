const { LineIndex } = require('./text');
const { fileKind, scriptRegions, parseCode, walk } = require('./parse');
const { consoleMethod } = require('./finder');

/**
 * @typedef {{start: number, end: number, text: string, call?: object}} TextEdit
 */

const isBlank = s => /^[ \t]*$/.test(s);
const isBlankOrLineComment = s => /^[ \t]*(\/\/.*)?$/.test(s);

/**
 * Plans edits that remove the given console calls without breaking syntax:
 * standalone statements are deleted (with their line when nothing else is on
 * it), sole bodies of if/loops become `{}`, arrow bodies become `{}`, and
 * calls used as values become `undefined`.
 * @returns {TextEdit[]}
 */
function planRemoval(text, calls) {
    const lines = new LineIndex(text);
    const deletions = [];
    const replacements = [];

    for (const call of calls) {
        if (call.context === 'statement') {
            deletions.push({ start: call.stmtStart, end: call.stmtEnd, text: '', calls: [call] });
        } else if (call.context === 'sole-body') {
            replacements.push({ start: call.stmtStart, end: call.stmtEnd, text: '{}', call });
        } else if (call.context === 'arrow-body') {
            replacements.push({ start: call.start, end: call.end, text: call.parenthesized ? 'undefined' : '{}', call });
        } else {
            replacements.push({ start: call.start, end: call.end, text: 'undefined', call });
        }
    }

    // Merge deletions that are only separated by spaces on the same line, e.g.
    // `console.log(1); console.log(2);`, so they don't produce overlapping edits.
    deletions.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const edit of deletions) {
        const last = merged[merged.length - 1];
        if (last && (edit.start <= last.end || isBlank(text.slice(last.end, edit.start)))) {
            last.end = Math.max(last.end, edit.end);
            last.calls.push(...edit.calls);
        } else {
            merged.push({ ...edit, calls: edit.calls.slice() });
        }
    }

    for (const edit of merged) {
        const firstLine = lines.lineAt(edit.start);
        const lastLine = lines.lineAt(edit.end);
        const lineStart = lines.lineStart(firstLine);
        const lineEnd = lines.lineEnd(lastLine);
        const before = text.slice(lineStart, edit.start);
        const after = text.slice(edit.end, lineEnd);

        if (isBlank(before) && isBlankOrLineComment(after)) {
            // Nothing else on the line(s): delete them entirely.
            edit.start = lineStart;
            edit.end = lastLine + 1 < lines.lineCount ? lines.lineStart(lastLine + 1) : lineEnd;
            if (lastLine + 1 >= lines.lineCount && firstLine > 0) {
                edit.start = lines.lineEnd(firstLine - 1);
            }
        } else if (isBlank(before)) {
            edit.end += /^[ \t]*/.exec(after)[0].length;
        } else {
            edit.start -= /[ \t]*$/.exec(before)[0].length;
        }
    }

    const edits = merged.map(edit => ({ start: edit.start, end: edit.end, text: '', call: edit.calls[0], calls: edit.calls }))
        .concat(replacements.map(edit => ({ ...edit, calls: [edit.call] })));
    return dropOverlaps(edits);
}

/**
 * Plans edits that turn standalone console statements into line comments.
 * Calls that share a line with other code can't be commented out safely and
 * are returned in `skipped`.
 * @returns {{edits: TextEdit[], skipped: object[]}}
 */
function planCommentOut(text, calls) {
    const lines = new LineIndex(text);
    const edits = [];
    const skipped = [];

    for (const call of calls) {
        const firstLine = lines.lineAt(call.stmtStart);
        const lastLine = lines.lineAt(call.stmtEnd);
        const before = text.slice(lines.lineStart(firstLine), call.stmtStart);
        const after = text.slice(call.stmtEnd, lines.lineEnd(lastLine));
        if (call.context !== 'statement' || !isBlank(before) || !isBlankOrLineComment(after)) {
            skipped.push(call);
            continue;
        }
        const indent = before.length;
        for (let line = firstLine; line <= lastLine; line++) {
            const lineText = lines.lineText(line);
            const column = Math.min(indent, /^[ \t]*/.exec(lineText)[0].length);
            const offset = lines.lineStart(line) + column;
            edits.push({ start: offset, end: offset, text: '// ', call, calls: [call] });
        }
    }
    return { edits: dropOverlaps(edits), skipped };
}

/**
 * Finds console calls that were commented out with line comments (by this
 * extension or by hand) and plans edits that restore them.
 * @returns {{edits: TextEdit[], count: number}}
 */
function planUncomment(text, methods, options = {}) {
    const lines = new LineIndex(text);
    const pattern = new RegExp(`^([ \\t]*)//[ \\t]?((?:window\\.|globalThis\\.)?console\\.(?:${methods.map(escapeRegExp).join('|')})\\s*\\()`);
    const commentLine = /^([ \t]*)\/\/( ?)/;
    const kind = fileKind(options.fileName, options.languageId) || 'jsx';
    const lang = kind === 'ts' || kind === 'tsx' ? 'tsx' : 'jsx';
    const edits = [];
    let count = 0;

    for (let line = 0; line < lines.lineCount; line++) {
        if (!pattern.test(lines.lineText(line))) {
            continue;
        }
        const group = [];
        let code = '';
        let matched = false;
        for (let next = line; next < lines.lineCount && next < line + 50; next++) {
            const m = commentLine.exec(lines.lineText(next));
            if (!m) {
                break;
            }
            group.push({ line: next, indent: m[1].length, length: 2 + m[2].length });
            code += lines.lineText(next).slice(m[0].length) + '\n';
            if (isSingleConsoleStatement(code, lang)) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            continue;
        }
        count++;
        for (const entry of group) {
            const start = lines.lineStart(entry.line) + entry.indent;
            edits.push({ start, end: start + entry.length, text: '' });
        }
        line = group[group.length - 1].line;
    }
    return { edits, count };
}

function isSingleConsoleStatement(code, lang) {
    try {
        const ast = parseCode(code, lang);
        if (ast.errors && ast.errors.length) {
            return false;
        }
        const body = ast.program.body;
        return body.length === 1 && body[0].type === 'ExpressionStatement' && consoleMethod(body[0].expression) !== null;
    } catch {
        return false;
    }
}

const CONTROL_FLOW = new Set(['ReturnStatement', 'ThrowStatement', 'IfStatement', 'ForStatement', 'ForInStatement',
    'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement', 'BreakStatement',
    'ContinueStatement', 'LabeledStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod',
    'ClassMethod', 'ClassPrivateMethod']);
const STATEMENT_LISTS = new Set(['body', 'consequent']);

/**
 * Works out where a log statement for the expression at [selStart, selEnd]
 * should go: after the enclosing statement, before control flow statements
 * (so `return x` still gets logged), or at the top of a function/loop/catch
 * body when the selection is a parameter or loop variable.
 * @returns {{offset: number, indent: string, prefixNewline: boolean, semicolon: boolean}}
 */
function findInsertPosition(text, selStart, selEnd, options = {}) {
    const lines = new LineIndex(text);
    const indentUnit = options.indentUnit || '    ';
    const fallback = () => {
        const line = lines.lineAt(selEnd);
        return {
            offset: lines.lineEnd(line),
            indent: /^[ \t]*/.exec(lines.lineText(line))[0],
            prefixNewline: true,
            semicolon: true
        };
    };

    const kind = fileKind(options.fileName, options.languageId);
    const region = scriptRegions(text, kind).find(r => r.start <= selStart && selEnd <= r.end);
    if (!region) {
        return fallback();
    }

    let ast;
    try {
        ast = parseCode(text.slice(region.start, region.end), region.lang);
    } catch {
        return fallback();
    }

    const start = selStart - region.start;
    const end = selEnd - region.start;
    const path = [];
    walk(ast.program, (node, parent, key, inArray) => {
        if (node.start > start || node.end < end) {
            return false;
        }
        path.push({ node, parent, key, inArray });
        return true;
    });

    const lineIndent = offset => /^[ \t]*/.exec(lines.lineText(lines.lineAt(offset)))[0];
    const hasSemicolon = node => text[region.start + node.end - 1] === ';';
    const atBlockStart = (block, owner) => {
        const first = block.body[0];
        const indent = first ? lineIndent(region.start + first.start) : lineIndent(region.start + owner.start) + indentUnit;
        return { offset: region.start + block.start + 1, indent, prefixNewline: true, semicolon: first ? hasSemicolon(first) : true };
    };
    const within = node => node && node.start <= start && end <= node.end;

    for (let i = path.length - 1; i >= 0; i--) {
        const { node, key, inArray } = path[i];

        if (FUNCTIONS.has(node.type) && node.params.some(within) && node.body.type === 'BlockStatement') {
            return atBlockStart(node.body, node);
        }
        if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && within(node.left) && node.body.type === 'BlockStatement') {
            return atBlockStart(node.body, node);
        }
        if (node.type === 'CatchClause' && within(node.param)) {
            return atBlockStart(node.body, node);
        }
        if (inArray && STATEMENT_LISTS.has(key) && /Statement|Declaration/.test(node.type)) {
            const absStart = region.start + node.start;
            const indent = lineIndent(absStart);
            if (CONTROL_FLOW.has(node.type)) {
                return { offset: lines.lineStart(lines.lineAt(absStart)), indent, prefixNewline: false, semicolon: true };
            }
            return { offset: region.start + node.end, indent, prefixNewline: true, semicolon: hasSemicolon(node) };
        }
    }
    return fallback();
}

/**
 * Builds the text of a log statement, e.g.
 * console.log('🪵 app.js:12 ~ user:', user);
 */
function buildLogStatement(expression, options = {}) {
    const quote = options.quote || "'";
    const head = [options.prefix, options.location ? options.location + ' ~' : ''].filter(Boolean).join(' ');
    const label = [head, expression.replace(/\s+/g, ' ')].filter(Boolean).join(' ');
    const escaped = label.replace(/\\/g, '\\\\').split(quote).join('\\' + quote);
    const method = options.method || 'log';
    return `console.${method}(${quote}${escaped}:${quote}, ${expression})${options.semicolon === false ? '' : ';'}`;
}

/** Removes edits that overlap an earlier one; WorkspaceEdit rejects overlaps. */
function dropOverlaps(edits) {
    const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const result = [];
    let lastEnd = -1;
    for (const edit of sorted) {
        if (edit.start < lastEnd) {
            continue;
        }
        result.push(edit);
        lastEnd = Math.max(lastEnd, edit.end);
    }
    return result;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plans edits that mark console calls as intentional by appending the ignore
 * comment to the end of each call's last line.
 * @returns {TextEdit[]}
 */
function planKeep(text, calls, marker = 'keep-log') {
    const lines = new LineIndex(text);
    const byLine = new Map();
    for (const call of calls) {
        const entry = byLine.get(call.endLine);
        if (entry) {
            entry.calls.push(call);
        } else {
            const offset = lines.lineEnd(call.endLine);
            const hasComment = /\/\/.*$/.test(text.slice(call.stmtEnd, offset));
            byLine.set(call.endLine, { start: offset, end: offset, text: hasComment ? ` ${marker}` : ` // ${marker}`, call, calls: [call] });
        }
    }
    return [...byLine.values()];
}

module.exports = {
    planRemoval,
    planCommentOut,
    planUncomment,
    planKeep,
    findInsertPosition,
    buildLogStatement
};
