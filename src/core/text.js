/**
 * Maps between string offsets and 0-based line/character positions.
 */
class LineIndex {
    constructor(text) {
        this.text = text;
        this.starts = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) {
                this.starts.push(i + 1);
            }
        }
    }

    get lineCount() {
        return this.starts.length;
    }

    lineAt(offset) {
        let low = 0;
        let high = this.starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.starts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    }

    position(offset) {
        const line = this.lineAt(offset);
        return { line, character: offset - this.starts[line] };
    }

    lineStart(line) {
        return this.starts[line];
    }

    /** Offset of the end of the line, before any \r\n or \n. */
    lineEnd(line) {
        let end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
        if (end > this.starts[line] && this.text.charCodeAt(end - 1) === 13) {
            end--;
        }
        return end;
    }

    lineText(line) {
        return this.text.slice(this.starts[line], this.lineEnd(line));
    }
}

/** Applies non-overlapping {start, end, text} edits to a string. */
function applyEdits(text, edits) {
    const sorted = edits.slice().sort((a, b) => b.start - a.start);
    let result = text;
    for (const edit of sorted) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result;
}

module.exports = { LineIndex, applyEdits };
