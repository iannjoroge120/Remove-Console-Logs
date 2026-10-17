/**
 * Minimal glob matching for the CLI, supporting the patterns used in the
 * extension settings: `**`, `*`, `?` and `{a,b}`. Paths use forward slashes.
 */
function globToRegExp(glob) {
    let re = '';
    let inGroup = false;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const slashAfter = glob[i + 2] === '/';
                re += slashAfter ? '(?:.*/)?' : '.*';
                i += slashAfter ? 2 : 1;
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            inGroup = true;
            re += '(?:';
        } else if (c === '}' && inGroup) {
            inGroup = false;
            re += ')';
        } else if (c === ',' && inGroup) {
            re += '|';
        } else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

function createMatcher(globs) {
    const patterns = (globs || []).map(globToRegExp);
    return relPath => patterns.some(p => p.test(relPath));
}

module.exports = { globToRegExp, createMatcher };
