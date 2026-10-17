// Bundles the extension and the CLI into dist/ with esbuild.
const esbuild = require('esbuild');
const fs = require('fs');

const watch = process.argv.includes('--watch');

const shared = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: true,
    sourcemap: true,
    logLevel: 'info'
};

const builds = [
    { ...shared, entryPoints: ['extension.js'], outfile: 'dist/extension.js', external: ['vscode'] },
    { ...shared, entryPoints: ['cli/bin.js'], outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } }
];

async function main() {
    if (watch) {
        for (const options of builds) {
            await (await esbuild.context(options)).watch();
        }
        return;
    }
    await Promise.all(builds.map(options => esbuild.build(options)));
    fs.chmodSync('dist/cli.js', 0o755);
}

main().catch(() => process.exit(1));
