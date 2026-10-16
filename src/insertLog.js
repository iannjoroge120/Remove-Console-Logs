const vscode = require('vscode');
const path = require('path');
const { findInsertPosition, buildLogStatement } = require('./core/transform');
const { getConfig } = require('./config');

const EXPRESSION_AT_CURSOR = /[\w$]+(?:(?:\?\.|\.)[\w$]+)*/;

/**
 * Inserts a tagged console.log for the selected expression (or the word under
 * the cursor) on the line after the enclosing statement. Works with multiple
 * cursors.
 */
async function insertLog() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const { document } = editor;
    const text = document.getText();
    const config = getConfig(document.uri).insertLog;
    const indentUnit = editor.options.insertSpaces ? ' '.repeat(Number(editor.options.tabSize) || 4) : '\t';
    const fileLabel = path.basename(document.fileName);

    const inserts = [];
    for (const selection of editor.selections) {
        let range = selection.isEmpty ? document.getWordRangeAtPosition(selection.active, EXPRESSION_AT_CURSOR) : selection;
        if (!range) {
            continue;
        }
        const expression = document.getText(range).trim();
        if (!expression) {
            continue;
        }
        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        const position = findInsertPosition(text, start, end, {
            fileName: document.fileName,
            languageId: document.languageId,
            indentUnit
        });
        const statement = buildLogStatement(expression, {
            prefix: config.prefix,
            location: config.includeLocation ? `${fileLabel}:${range.start.line + 1}` : '',
            quote: config.quote,
            method: config.method,
            semicolon: position.semicolon
        });
        const insertText = position.prefixNewline
            ? `\n${position.indent}${statement}`
            : `${position.indent}${statement}\n`;
        inserts.push({ position: document.positionAt(position.offset), text: insertText });
    }

    if (!inserts.length) {
        vscode.window.showInformationMessage('Select an expression or place the cursor on a variable to log it.');
        return;
    }
    await editor.edit(builder => {
        for (const insert of inserts) {
            builder.insert(insert.position, insert.text);
        }
    });
}

module.exports = { insertLog };
