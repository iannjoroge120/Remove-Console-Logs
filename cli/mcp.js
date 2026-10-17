const readline = require('readline');
const path = require('path');
const { scanProject, applyToProject } = require('../src/core/project');
const { version } = require('../package.json');

/**
 * Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0),
 * so agents such as Claude Code, Cursor and Claude Desktop can find and clean
 * up console calls with the same engine as the extension.
 */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const scopeProperties = {
    paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or folders to limit the search to, relative to the project root. Omit for the whole project.'
    },
    changed_only: {
        type: 'boolean',
        description: 'Only consider lines added or changed since the last git commit. Use this to clean up debugging you just added without touching existing logs.'
    },
    methods: {
        type: 'array',
        items: { type: 'string' },
        description: 'Console methods to match, e.g. ["log", "debug"]. Defaults to every method except warn and error.'
    }
};

const TOOLS = [
    {
        name: 'find_console_logs',
        title: 'Find console logs',
        description: 'List console.log/debug/info/etc. calls in the project with file, line and code. Read-only. '
            + 'Calls marked with a // keep-log comment and console.warn/error are excluded by default.',
        inputSchema: { type: 'object', properties: scopeProperties },
        annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
        name: 'remove_console_logs',
        title: 'Remove console logs',
        description: 'Remove, comment out, keep (add // keep-log) or uncomment console calls, keeping the code syntactically valid. '
            + 'Use changed_only to clean up only debugging added since the last commit, or locations to target specific lines found with find_console_logs. '
            + 'Use dry_run to preview.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['remove', 'comment', 'keep', 'uncomment'], description: 'What to do. Default: remove.' },
                ...scopeProperties,
                locations: {
                    type: 'array',
                    description: 'Specific calls to act on, as returned by find_console_logs.',
                    items: {
                        type: 'object',
                        properties: { path: { type: 'string' }, line: { type: 'integer', description: '1-based line number' } },
                        required: ['path', 'line']
                    }
                },
                dry_run: { type: 'boolean', description: 'Report what would change without writing files.' }
            }
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }
];

function toOptions(root, input = {}) {
    return {
        root,
        paths: input.paths || [],
        changed: Boolean(input.changed_only),
        methods: input.methods && input.methods.length ? input.methods : undefined,
        locations: input.locations && input.locations.length ? input.locations : null,
        dryRun: Boolean(input.dry_run)
    };
}

async function callTool(root, name, input) {
    if (name === 'find_console_logs') {
        const { files } = await scanProject(toOptions(root, input));
        const found = files.filter(f => f.calls.length);
        const total = found.reduce((n, f) => n + f.calls.length, 0);
        if (!total) {
            return 'No console calls found.';
        }
        const lines = [`Found ${total} console call${total === 1 ? '' : 's'} in ${found.length} file${found.length === 1 ? '' : 's'}:`];
        for (const file of found) {
            for (const call of file.calls) {
                lines.push(`${file.rel}:${call.line + 1}  ${call.snippet}`);
            }
        }
        const kept = files.reduce((n, f) => n + f.kept, 0);
        if (kept) {
            lines.push(`(${kept} more marked with the keep comment were excluded.)`);
        }
        return lines.join('\n');
    }
    if (name === 'remove_console_logs') {
        const action = (input && input.action) || 'remove';
        const summary = await applyToProject(action, toOptions(root, input));
        const verbs = { remove: 'removed', comment: 'commented out', keep: 'marked to keep', uncomment: 'restored' };
        const lines = [`${summary.dryRun ? 'Would have ' : ''}${verbs[action]} ${summary.count} console call${summary.count === 1 ? '' : 's'} in ${summary.files.length} file${summary.files.length === 1 ? '' : 's'}.`];
        summary.files.forEach(f => lines.push(`- ${f.rel} (${f.count})`));
        if (summary.skipped) {
            lines.push(`${summary.skipped} could not be commented out because they share a line with other code.`);
        }
        summary.errors.forEach(e => lines.push(`Could not parse ${e}`));
        return lines.join('\n');
    }
    throw new Error(`Unknown tool: ${name}`);
}

/** Handles one JSON-RPC message; returns the response object, or null for notifications. */
async function handleMessage(root, message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    const reply = result => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, msg) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
        case 'initialize': {
            const requested = params && params.protocolVersion;
            return reply({
                protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'console-logs-remover', title: 'Console Logs Remover', version },
                instructions: `Finds and safely removes console.* calls in the project at ${root}. `
                    + 'Before finishing a coding task, call remove_console_logs with changed_only: true to clean up debugging logs you added.'
            });
        }
        case 'ping':
            return reply({});
        case 'tools/list':
            return reply({ tools: TOOLS });
        case 'tools/call': {
            try {
                const text = await callTool(root, params && params.name, (params && params.arguments) || {});
                return reply({ content: [{ type: 'text', text }] });
            } catch (err) {
                return reply({ content: [{ type: 'text', text: err.message }], isError: true });
            }
        }
        default:
            if (method && method.startsWith('notifications/')) {
                return null;
            }
            return fail(-32601, `Method not found: ${method}`);
    }
}

function startServer({ root = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
    const resolvedRoot = path.resolve(root);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const send = obj => output.write(JSON.stringify(obj) + '\n');
    rl.on('line', async line => {
        if (!line.trim()) {
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        const response = await handleMessage(resolvedRoot, message);
        if (response) {
            send(response);
        }
    });
    return rl;
}

module.exports = { startServer, handleMessage, TOOLS };
