const vscode = require('vscode');
const { parseJsonc } = require('./core/project');

const SERVER_NAME = 'console-logs';
const NPX_ARGS = ['-y', 'console-logs-remover', 'mcp'];

const AGENT_INSTRUCTIONS = `## Console logs
- Use \`console.log\` freely while debugging, but remove what you added before finishing:
  run \`npx console-logs-remover --changed --fix\` (only touches lines changed since the last commit).
- To keep a log on purpose, add \`// keep-log\` at the end of its line.
- \`console.warn\` and \`console.error\` are kept.`;

const PRE_COMMIT = `#!/bin/sh
# Block commits that add console.log calls (mark intentional ones with // keep-log)
npx --yes console-logs-remover --staged`;

async function copy(text, what) {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`Copied ${what} to the clipboard.`);
}

/** Adds the MCP server to a JSON config file in the first workspace folder and opens it. */
async function addMcpServer(relativePath, rootKey) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) {
        vscode.window.showWarningMessage('Open a folder first.');
        return;
    }
    const uri = vscode.Uri.joinPath(folder.uri, relativePath);
    let config = {};
    const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
    if (exists) {
        try {
            config = parseJsonc(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        } catch (err) {
            vscode.window.showErrorMessage(`Could not read ${relativePath}: ${err.message}`);
            return;
        }
    }
    config[rootKey] = config[rootKey] || {};
    if (config[rootKey][SERVER_NAME]) {
        vscode.window.showInformationMessage(`${relativePath} already has the "${SERVER_NAME}" server.`);
    } else {
        config[rootKey][SERVER_NAME] = rootKey === 'servers'
            ? { type: 'stdio', command: 'npx', args: NPX_ARGS }
            : { command: 'npx', args: NPX_ARGS };
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
    }
    await vscode.window.showTextDocument(uri);
}

/** Quick pick of ways to use the extension's engine from AI agents and CI. */
async function setupAi() {
    const hasLmTools = Boolean(vscode.lm && typeof vscode.lm.registerTool === 'function');
    const items = [
        {
            label: '$(terminal) Claude Code',
            description: 'Copy the "claude mcp add" command',
            run: () => copy(`claude mcp add ${SERVER_NAME} -- npx ${NPX_ARGS.join(' ')}`, 'the Claude Code command')
        },
        {
            label: '$(json) Cursor',
            description: 'Add the MCP server to .cursor/mcp.json',
            run: () => addMcpServer('.cursor/mcp.json', 'mcpServers')
        },
        {
            label: '$(json) Other MCP clients',
            description: 'Copy the MCP server config (Claude Desktop, Windsurf, ...)',
            run: () => copy(JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'npx', args: NPX_ARGS } } }, null, 2), 'the MCP config')
        },
        {
            label: '$(book) Agent instructions',
            description: 'Copy a snippet for AGENTS.md / CLAUDE.md / .cursorrules',
            run: () => copy(AGENT_INSTRUCTIONS, 'the agent instructions')
        },
        {
            label: '$(git-commit) Pre-commit hook',
            description: 'Copy a hook that blocks commits adding console.log',
            run: () => copy(PRE_COMMIT, 'the pre-commit hook')
        }
    ];
    if (hasLmTools) {
        items.unshift({
            label: '$(sparkle) Copilot and other VS Code chat agents',
            description: 'Built in: mention #consoleLogs or #removeConsoleLogs in chat',
            run: () => vscode.window.showInformationMessage(
                'The tools are already available to agent mode. Ask e.g. "remove the console logs I added" or mention #consoleLogs / #removeConsoleLogs.')
        });
    }
    const choice = await vscode.window.showQuickPick(items, {
        title: 'Console Logs: Set Up AI Agents',
        placeHolder: 'Let AI agents find and clean up console logs with this extension\'s engine'
    });
    if (choice) {
        await choice.run();
    }
}

module.exports = { setupAi, AGENT_INSTRUCTIONS, PRE_COMMIT };
