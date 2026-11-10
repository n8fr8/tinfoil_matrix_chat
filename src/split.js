// Splits long replies into several messages: text replies so they are easier
// to read in a chat, and voice replies because text-to-speech requests have a
// length limit (voxtral-tts: 2000 characters, CJK counting as 3).
//
// Splits at the largest natural break that fits: paragraphs, then lines, then
// sentences (including the Tibetan shad), then words. Fenced code blocks are
// kept whole when they fit, and re-fenced when they have to be split.

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/u;

/** Length as voxtral-tts counts it: CJK characters count as 3. */
export function weightedLength(text) {
    let n = 0;
    for (const ch of text) n += CJK.test(ch) ? 3 : 1;
    return n;
}

/**
 * @param {string} text
 * @param {number} max maximum length of each piece
 * @param {(s: string) => number} [len] how to measure length
 * @returns {string[]} non-empty pieces, in order
 */
export function splitMessage(text, max, len = (s) => s.length) {
    text = (text || "").trim();
    if (!text) return [];
    if (len(text) <= max) return [text];
    const pieces = [];
    for (const block of blocks(text)) {
        if (len(block) <= max) pieces.push(block);
        else pieces.push(...splitBlock(block, max, len));
    }
    return pack(pieces, max, len, "\n\n");
}

// Paragraphs, with each fenced code block kept as one block.
function blocks(text) {
    const out = [];
    let para = [];
    let fence = null;
    const flush = () => {
        const p = para.join("\n").trim();
        if (p) out.push(p);
        para = [];
    };
    for (const line of text.split("\n")) {
        const marker = line.match(/^\s*(```|~~~)/)?.[1];
        if (fence) {
            para.push(line);
            if (marker === fence) {
                flush();
                fence = null;
            }
        } else if (marker) {
            flush();
            para.push(line);
            fence = marker;
        } else if (!line.trim()) {
            flush();
        } else {
            para.push(line);
        }
    }
    flush();
    return out;
}

function splitBlock(block, max, len) {
    const code = block.match(/^(\s*(```|~~~)[^\n]*)\n([\s\S]*?)\n?\s*\2\s*$/);
    if (code) {
        // Re-fence each part so every message renders as code.
        const [, open, marker, body] = code;
        const room = max - len(open) - len(marker) - 2;
        return pack(splitLines(body, room, len), room, len, "\n").map((p) => `${open}\n${p}\n${marker}`);
    }
    return pack(splitLines(block, max, len), max, len, "\n");
}

function splitLines(text, max, len) {
    return text.split("\n").flatMap((line) => (len(line) <= max ? [line] : splitSentences(line, max, len)));
}

function splitSentences(line, max, len) {
    // Sentence ends: . ! ? and CJK/Tibetan full stops, followed by a space (or not, for CJK).
    const sentences = line.match(/[^.!?。！？།]+(?:[.!?。！？]+["')\]]*\s*|།+\s*|$)/gu) || [line];
    const parts = sentences.flatMap((s) => (len(s) <= max ? [s] : splitWords(s, max, len)));
    return pack(parts, max, len, "", false);
}

function splitWords(text, max, len) {
    const words = text.split(/(?<=[\s་])/u); // keep spaces and Tibetan tsheg on the left
    const out = [];
    let cur = "";
    for (const w of words) {
        if (len(w) > max) {
            if (cur) out.push(cur);
            cur = "";
            out.push(...hardSplit(w, max, len));
        } else if (len(cur + w) > max) {
            out.push(cur);
            cur = w;
        } else {
            cur += w;
        }
    }
    if (cur) out.push(cur);
    return out;
}

function hardSplit(text, max, len) {
    const out = [];
    let cur = "";
    for (const ch of text) {
        if (len(cur + ch) > max) {
            out.push(cur);
            cur = "";
        }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

// Greedily joins pieces into chunks that fit.
function pack(pieces, max, len, sep, trim = true) {
    const out = [];
    let cur = "";
    for (const piece of pieces) {
        const p = trim ? piece.trim() : piece;
        if (!p.trim()) continue;
        if (!cur) cur = p;
        else if (len(cur + sep + p) <= max) cur += sep + p;
        else {
            out.push(cur.trim());
            cur = p;
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}
