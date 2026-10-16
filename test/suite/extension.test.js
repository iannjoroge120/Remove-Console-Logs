const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const workspace = process.env.FIXTURE_WORKSPACE;
const fileUri = rel => vscode.Uri.file(path.join(workspace, rel));
const read = async rel => (await vscode.workspace.openTextDocument(fileUri(rel))).getText();

async function openUntitled(content, language = 'javascript') {
	const document = await vscode.workspace.openTextDocument({ content, language });
	return vscode.window.showTextDocument(document);
}

suite('Console Logs Remover (integration)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('IanNjoroge.console-logs-remover').activate();
	});

	teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

	test('removes console calls in the current file and undoes', async () => {
		const original = 'const a = fn(b(c));\nconsole.log(a, fn(1));\nif (a) console.debug(a);\n';
		const editor = await openUntitled(original);

		await vscode.commands.executeCommand('consoleLogsRemover.removeFromFile');
		assert.strictEqual(editor.document.getText(), 'const a = fn(b(c));\nif (a) {}\n');

		await vscode.commands.executeCommand('consoleLogsRemover.undo');
		assert.strictEqual(editor.document.getText(), original);
	});

	test('removes only the call under the cursor', async () => {
		const editor = await openUntitled('console.log(1);\nconsole.log(2);\n');
		editor.selection = new vscode.Selection(1, 3, 1, 3);
		await vscode.commands.executeCommand('consoleLogsRemover.removeFromSelection');
		assert.strictEqual(editor.document.getText(), 'console.log(1);\n');
	});

	test('comments out and uncomments', async () => {
		const original = 'go();\nconsole.log({\n  a: 1,\n});\n';
		const editor = await openUntitled(original);
		await vscode.commands.executeCommand('consoleLogsRemover.commentOutInFile');
		assert.strictEqual(editor.document.getText(), 'go();\n// console.log({\n//   a: 1,\n// });\n');
		await vscode.commands.executeCommand('consoleLogsRemover.uncommentInFile');
		assert.strictEqual(editor.document.getText(), original);
	});

	test('inserts a tagged log after the statement', async () => {
		const editor = await openUntitled('function f(user) {\n  const name = user.name;\n}\n');
		editor.options = { insertSpaces: true, tabSize: 2 };
		editor.selection = new vscode.Selection(1, 9, 1, 9);
		await vscode.commands.executeCommand('consoleLogsRemover.insertLog');
		assert.match(editor.document.getText(), /const name = user\.name;\n {2}console\.log\('🪵 Untitled-\d+:2 ~ name:', name\);\n}/);
	});

	test('offers Quick Fixes on a console call', async function () {
		// Waits for every code action provider, including the TypeScript server starting up.
		this.timeout(60000);
		const editor = await openUntitled('console.log(1);\n');
		const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', editor.document.uri, new vscode.Range(0, 2, 0, 2));
		const titles = actions.map(a => a.title);
		assert.ok(titles.includes('Remove console.log'), titles.join(', '));
		assert.ok(titles.includes('Keep this console.log (add // keep-log)'), titles.join(', '));
	});

	test('removes across the workspace, honouring excludes and kept methods', async () => {
		await vscode.commands.executeCommand('consoleLogsRemover.removeFromWorkspace');
		assert.strictEqual(await read('src/app.js'), "function greet(user) {\n  console.error('kept');\n  return `hi ${user}`;\n}\n");
		assert.strictEqual(await read('src/view.tsx'), 'export const View = () => <button onClick={() => {}}>Go</button>;\n');
		assert.strictEqual(await read('dist/bundle.js'), "console.log('excluded by default');\n");

		await vscode.commands.executeCommand('consoleLogsRemover.undo');
		assert.match(await read('src/app.js'), /console\.log\('greeting'/);
		assert.match(await read('src/view.tsx'), /console\.log\('clicked'\)/);
	});
});
