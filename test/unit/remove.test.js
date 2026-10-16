const assert = require('assert');
const { findConsoleCalls } = require('../../src/core/finder');
const { planRemoval } = require('../../src/core/transform');
const { applyEdits } = require('../../src/core/text');
const { parseCode } = require('../../src/core/parse');

function remove(text, fileName = 'test.jsx', options = {}) {
    const { calls } = findConsoleCalls(text, { fileName, ...options });
    return applyEdits(text, planRemoval(text, calls.filter(c => !c.ignored)));
}

function assertParses(code, lang = 'jsx') {
    const ast = parseCode(code, lang);
    assert.deepStrictEqual(ast.errors, [], `output does not parse:\n${code}`);
}

suite('planRemoval', () => {
    const cases = [
        ['nested parentheses', 'console.log(foo(a), b);\nnext();\n', 'next();\n'],
        ['parenthesis inside a string', 'console.log("a);b");\nkeep();\n', 'keep();\n'],
        ['multi-line object argument', 'function a() {\n  console.log({\n    a: fn(1),\n  });\n  return 1;\n}\n', 'function a() {\n  return 1;\n}\n'],
        ['sole body of if', 'if (x) console.log(1);\nelse go();\n', 'if (x) {}\nelse go();\n'],
        ['sole body of loop', 'for (const a of b) console.log(a);\n', 'for (const a of b) {}\n'],
        ['arrow function body', 'const f = () => console.log(x);\n', 'const f = () => {};\n'],
        ['parenthesized arrow body', 'const f = () => (console.log(x));\n', 'const f = () => (undefined);\n'],
        ['used as a value', 'const y = console.log(x) || 1;\n', 'const y = undefined || 1;\n'],
        ['guarded by &&', 'debug && console.log(x);\nz();\n', 'z();\n'],
        ['commented out call is left alone', '// console.log("x")\nrun();\n', '// console.log("x")\nrun();\n'],
        ['call inside a string is left alone', 'const s = "console.log(1)";\n', 'const s = "console.log(1)";\n'],
        ['two calls on one line', '  console.log(1); console.log(2);\nb();\n', 'b();\n'],
        ['call after other code', 'a(); console.log(1);\n', 'a();\n'],
        ['call before other code', 'console.log(1); a();\n', 'a();\n'],
        ['no semicolon', 'console.log(a)\nfoo(bar)\n', 'foo(bar)\n'],
        ['last line without newline', 'a();\nconsole.log(1)', 'a();'],
        ['trailing comment goes too', 'console.log(1); // debug\na();\n', 'a();\n'],
        ['nested console call', 'console.log(console.log(1));\n', ''],
        ['optional call', 'console.log?.(1);\nconsole?.log(2);\n', ''],
        ['computed member', 'console["log"](1);\n', ''],
        ['window.console', 'window.console.log(1);\nglobalThis.console.debug(2);\n', ''],
        ['warn and error kept by default', 'console.warn(1);\nconsole.error(2);\n', 'console.warn(1);\nconsole.error(2);\n'],
        ['other objects untouched', 'logger.log(1);\nmyconsole.log(2);\n', 'logger.log(1);\nmyconsole.log(2);\n'],
        ['reference without call untouched', 'const log = console.log;\n', 'const log = console.log;\n'],
        ['jsx', 'const C = () => <div onClick={() => console.log(1)}>{console.log(2)}</div>;\n',
            'const C = () => <div onClick={() => {}}>{undefined}</div>;\n'],
        ['template literal', 'console.log(`a ${b(c)} )`);\nx();\n', 'x();\n'],
        ['regex argument', 'console.log(/\\)/.test(s));\nx();\n', 'x();\n'],
        ['crlf line endings', 'a();\r\n  console.log(1);\r\nb();\r\n', 'a();\r\nb();\r\n'],
        ['switch case', 'switch (a) {\n  case 1:\n    console.log(1);\n    break;\n}\n', 'switch (a) {\n  case 1:\n    break;\n}\n']
    ];

    for (const [name, input, expected] of cases) {
        test(name, () => {
            const output = remove(input);
            assert.strictEqual(output, expected);
            assertParses(output);
        });
    }

    test('typescript generics and casts', () => {
        const input = 'const x = <T,>(a: T): T => {\n  console.log(a as unknown);\n  return a;\n};\n';
        assert.strictEqual(remove(input, 'a.ts'), 'const x = <T,>(a: T): T => {\n  return a;\n};\n');
    });

    test('ignore comment on the same line', () => {
        assert.strictEqual(remove('console.log(1); // keep-log\nconsole.log(2);\n'), 'console.log(1); // keep-log\n');
    });

    test('ignore comment on the line above', () => {
        assert.strictEqual(remove('// keep-log\nconsole.log(1);\nconsole.log(2);\n'), '// keep-log\nconsole.log(1);\n');
    });

    test('custom method list', () => {
        assert.strictEqual(remove('console.log(1);\nconsole.error(2);\n', 'a.js', { methods: ['error'] }), 'console.log(1);\n');
    });

    test('vue single file component', () => {
        const input = '<template><div @click="console.log(1)"/></template>\n<script setup lang="ts">\nconst a: number = 1\nconsole.log(a)\n</script>\n';
        assert.strictEqual(remove(input, 'a.vue'),
            '<template><div @click="console.log(1)"/></template>\n<script setup lang="ts">\nconst a: number = 1\n</script>\n');
    });

    test('svelte and html scripts, skipping non-JS script types', () => {
        const input = '<script>\n  console.log(1);\n  let a = 1;\n</script>\n<script type="application/json">{"console.log(2)": 1}</script>\n';
        assert.strictEqual(remove(input, 'a.svelte'),
            '<script>\n  let a = 1;\n</script>\n<script type="application/json">{"console.log(2)": 1}</script>\n');
    });

    test('astro frontmatter', () => {
        const input = '---\nconst a = 1;\nconsole.log(a);\n---\n<h1>{a}</h1>\n';
        assert.strictEqual(remove(input, 'a.astro'), '---\nconst a = 1;\n---\n<h1>{a}</h1>\n');
    });

    test('unsupported files are reported as such', () => {
        const result = findConsoleCalls('console.log(1)', { fileName: 'a.py' });
        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.calls.length, 0);
    });

    test('call metadata', () => {
        const [call] = findConsoleCalls('\n  console.log("🪵 hi", x);\n', { fileName: 'a.js' }).calls;
        assert.strictEqual(call.method, 'log');
        assert.strictEqual(call.line, 1);
        assert.strictEqual(call.firstArg, '🪵 hi');
        assert.strictEqual(call.context, 'statement');
        assert.strictEqual(call.snippet, 'console.log("🪵 hi", x)');
    });
});
