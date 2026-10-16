const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTests } = require('@vscode/test-electron');

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../');

		// The path to the extension test script
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Tests edit files, so they run against a throwaway copy of the fixture workspace
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'console-logs-remover-test-'));
		fs.cpSync(path.resolve(__dirname, 'fixtures/workspace'), workspace, { recursive: true });

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [workspace, '--disable-extensions'],
			extensionTestsEnv: { FIXTURE_WORKSPACE: workspace }
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	}
}

main();
