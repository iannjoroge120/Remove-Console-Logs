const { main } = require('./index');

main().then(code => {
    if (code !== null) {
        process.exitCode = code;
    }
});
