const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findConsoleCalls } = require('../../src/core/finder');
const { planKeep } = require('../../src/core/transform');
const { applyEdits } = require('../../src/core/text');
const { globToRegExp } = require('../../src/core/glob');
const { parseJsonc, scanProject, applyToProject } = require('../../src/core/project');
const { main } = require('../../cli/index');
const { handleMessage } = require('../../cli/mcp');

function makeProject(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clr-unit-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

function capture() {
    const lines = [];
    return { lines, out: { log: s => lines.push(String(s)), error: s => lines.push(`ERR ${s}`) } };
}

suite('planKeep', () => {
    test('appends the ignore comment, reusing an existing line comment', () => {
        const text = 'console.log(1);\nconsole.log({\n  a: 1,\n}); // note\n';
        const calls = findConsoleCalls(text, { fileName: 'a.js' }).calls;
        const output = applyEdits(text, planKeep(text, calls, 'keep-log'));
        assert.strictEqual(output, 'console.log(1); // keep-log\nconsole.log({\n  a: 1,\n}); // note keep-log\n');
        assert.strictEqual(findConsoleCalls(output, { fileName: 'a.js' }).calls.every(c => c.ignored), true);
    });
});

suite('glob and settings', () => {
    test('globToRegExp handles **, * and braces', () => {
        assert.ok(globToRegExp('**/node_modules/**').test('a/node_modules/b/c.js'));
        assert.ok(globToRegExp('**/node_modules/**').test('node_modules/x.js'));
        assert.ok(globToRegExp('**/*.{js,ts}').test('src/a.ts'));
        assert.ok(globToRegExp('**/*.{js,ts}').test('a.js'));
        assert.ok(!globToRegExp('**/*.{js,ts}').test('a.json'));
        assert.ok(globToRegExp('**/*.min.js').test('lib/x.min.js'));
    });

    test('parseJsonc strips comments and trailing commas but not strings', () => {
        const parsed = parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1, 2,],\n}');
        assert.deepStrictEqual(parsed, { a: 'http://x', b: [1, 2] });
    });
});

suite('project scan and apply', () => {
    test('honours default excludes and .vscode/settings.json', async () => {
        const root = makeProject({
            'src/a.js': 'console.log(1);\nconsole.error(2);\n',
            'dist/b.js': 'console.log(3);\n',
            'node_modules/c/index.js': 'console.log(4);\n',
            '.vscode/settings.json': '{ "consoleLogsRemover.methods": ["log", "error"], }'
        });
        const { files } = await scanProject({ root, respectGitignore: false });
        assert.deepStrictEqual(files.map(f => [f.rel, f.calls.map(c => c.method)]), [['src/a.js', ['log', 'error']]]);
    });

    test('applies to explicit locations only, and supports dry runs', async () => {
        const root = makeProject({ 'a.ts': 'console.log(1);\nconsole.log(2);\n' });
        const dry = await applyToProject('remove', { root, locations: [{ path: 'a.ts', line: 2 }], dryRun: true });
        assert.strictEqual(dry.count, 1);
        assert.strictEqual(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'console.log(1);\nconsole.log(2);\n');
        await applyToProject('remove', { root, locations: [{ path: 'a.ts', line: 2 }] });
        assert.strictEqual(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'console.log(1);\n');
    });
});

suite('CLI', () => {
    test('--check exits 1 and lists calls; --fix cleans up; then exits 0', async () => {
        const root = makeProject({ 'src/a.js': 'go();\nconsole.log(f(x));\n' });
        let c = capture();
        assert.strictEqual(await main(['--root', root, '--no-gitignore'], c.out), 1);
        assert.ok(c.lines.some(l => l.includes('2:1  console.log(f(x))')), c.lines.join('\n'));

        c = capture();
        assert.strictEqual(await main(['--root', root, '--no-gitignore', '--fix'], c.out), 0);
        assert.strictEqual(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'go();\n');

        c = capture();
        assert.strictEqual(await main(['--root', root, '--no-gitignore'], c.out), 0);
    });

    test('--json output', async () => {
        const root = makeProject({ 'a.js': 'console.debug(1);\n' });
        const c = capture();
        await main(['--root', root, '--no-gitignore', '--json'], c.out);
        const json = JSON.parse(c.lines.join('\n'));
        assert.deepStrictEqual(json.files, [{ path: 'a.js', calls: [{ line: 1, column: 1, method: 'debug', code: 'console.debug(1)' }] }]);
    });

    test('unknown options exit 2', async () => {
        const c = capture();
        assert.strictEqual(await main(['--nope'], c.out), 2);
    });
});

suite('MCP server', () => {
    test('initialize, list and call tools', async () => {
        const root = makeProject({ 'a.js': 'console.log(1);\n' });
        const init = await handleMessage(root, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
        assert.strictEqual(init.result.protocolVersion, '2025-03-26');
        assert.strictEqual(await handleMessage(root, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);

        const list = await handleMessage(root, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.deepStrictEqual(list.result.tools.map(t => t.name), ['find_console_logs', 'remove_console_logs']);

        const found = await handleMessage(root, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_console_logs', arguments: {} } });
        assert.match(found.result.content[0].text, /a\.js:1 {2}console\.log\(1\)/);

        const removed = await handleMessage(root, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remove_console_logs', arguments: { action: 'remove' } } });
        assert.match(removed.result.content[0].text, /removed 1 console call in 1 file/);
        assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), '');
    });

    test('errors are reported as tool errors, unknown methods as JSON-RPC errors', async () => {
        const root = makeProject({});
        const bad = await handleMessage(root, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_console_logs', arguments: { paths: ['missing'] } } });
        assert.strictEqual(bad.result.isError, true);
        const unknown = await handleMessage(root, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
        assert.strictEqual(unknown.error.code, -32601);
    });
});
