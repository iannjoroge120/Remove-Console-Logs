const assert = require('assert');
const { findConsoleCalls } = require('../../src/core/finder');
const { planCommentOut, planUncomment, findInsertPosition, buildLogStatement } = require('../../src/core/transform');
const { applyEdits } = require('../../src/core/text');
const { parseAddedLines } = require('../../src/core/git');

const calls = (text, fileName = 'a.js') => findConsoleCalls(text, { fileName }).calls;

suite('planCommentOut / planUncomment', () => {
    const source = 'function f() {\n  console.log({\n    a: 1,\n  });\n  if (x) console.log(2);\n  go(); console.log(3);\n}\n';

    test('comments out standalone statements and skips the rest', () => {
        const plan = planCommentOut(source, calls(source));
        assert.strictEqual(applyEdits(source, plan.edits),
            'function f() {\n  // console.log({\n  //   a: 1,\n  // });\n  if (x) console.log(2);\n  go(); console.log(3);\n}\n');
        assert.strictEqual(plan.skipped.length, 2);
    });

    test('uncomment restores what comment out produced', () => {
        const commented = applyEdits(source, planCommentOut(source, calls(source)).edits);
        const plan = planUncomment(commented, ['log']);
        assert.strictEqual(plan.count, 1);
        assert.strictEqual(applyEdits(commented, plan.edits), source);
    });

    test('uncomment ignores ordinary comments and other methods', () => {
        const text = '// console is great\n// console.warn(1);\n//console.log(2)\n';
        const plan = planUncomment(text, ['log']);
        assert.strictEqual(applyEdits(text, plan.edits), '// console is great\n// console.warn(1);\nconsole.log(2)\n');
    });
});

suite('insert log', () => {
    const insert = (text, target, fileName = 'a.js') => {
        const start = text.indexOf(target);
        const pos = findInsertPosition(text, start, start + target.length, { fileName, indentUnit: '  ' });
        const statement = buildLogStatement(target, { prefix: '🪵', semicolon: pos.semicolon });
        const insertText = pos.prefixNewline ? `\n${pos.indent}${statement}` : `${pos.indent}${statement}\n`;
        return text.slice(0, pos.offset) + insertText + text.slice(pos.offset);
    };

    test('after a multi-line declaration', () => {
        const text = 'function f() {\n  const user = {\n    a: 1,\n  };\n}\n';
        assert.strictEqual(insert(text, 'user'),
            "function f() {\n  const user = {\n    a: 1,\n  };\n  console.log('🪵 user:', user);\n}\n");
    });

    test('before a return statement', () => {
        const text = 'function f(a) {\n  return a.b;\n}\n';
        assert.strictEqual(insert(text, 'a.b'), "function f(a) {\n  console.log('🪵 a.b:', a.b);\n  return a.b;\n}\n");
    });

    test('at the top of the function body for a parameter', () => {
        const text = 'function f(user) {\n  go();\n}\n';
        assert.strictEqual(insert(text, 'user'), "function f(user) {\n  console.log('🪵 user:', user);\n  go();\n}\n");
    });

    test('inside a for...of body for the loop variable', () => {
        const text = 'for (const item of items) {\n  use(item);\n}\n';
        assert.strictEqual(insert(text, 'item'), "for (const item of items) {\n  console.log('🪵 item:', item);\n  use(item);\n}\n");
    });

    test('follows the file\'s semicolon style', () => {
        const text = 'const a = 1\n';
        assert.strictEqual(insert(text, 'a'), "const a = 1\nconsole.log('🪵 a:', a)\n");
    });

    test('label includes location and escapes quotes', () => {
        assert.strictEqual(buildLogStatement("m['k']", { prefix: '🪵', location: 'a.js:3' }),
            "console.log('🪵 a.js:3 ~ m[\\'k\\']:', m['k']);");
    });
});

suite('git hunk parsing', () => {
    test('collects added line numbers (0-based)', () => {
        const diff = '@@ -1,0 +2,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +23,0 @@\n';
        assert.deepStrictEqual([...parseAddedLines(diff)], [1, 2, 11]);
    });
});
