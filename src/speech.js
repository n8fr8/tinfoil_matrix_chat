// Client for the Tibetan speech sidecar (speech/server.py): MMS text-to-speech
// and speech-to-text running in a second container in the same enclave,
// reached over the internal network (e.g. http://speech:8000).

import { toWav16kMono } from "./media.js";

export class SpeechSidecar {
    constructor(url, { timeoutMs = 120000 } = {}) {
        this.url = url.replace(/\/+$/, "");
        this.timeoutMs = timeoutMs;
    }

    async request(path, body, contentType) {
        const res = await fetch(this.url + path, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            const err = await res.text().catch(() => "");
            throw new Error(`speech sidecar ${path} returned ${res.status}: ${err.slice(0, 200)}`);
        }
        return res;
    }

    // Tibetan text -> WAV audio.
    async tts(text) {
        const res = await this.request("/tts", JSON.stringify({ text }), "application/json");
        return Buffer.from(await res.arrayBuffer());
    }

    // Any audio/video -> Tibetan transcript.
    async stt(data) {
        const res = await this.request("/stt", await toWav16kMono(data), "audio/wav");
        return ((await res.json()).text || "").trim();
    }

    // "ok", "loading" or "unreachable", for the status endpoint.
    async status() {
        try {
            const res = await fetch(this.url + "/health", { signal: AbortSignal.timeout(2000) });
            return res.ok ? "ok" : "loading";
        } catch {
            return "unreachable";
        }
    }
}

const isTibetanChar = (ch) => ch >= "\u0F00" && ch <= "\u0FFF";
const isWordChar = (ch) => /[\p{L}\p{M}\p{N}]/u.test(ch);

// Splits text into runs of Tibetan and other-script speech, e.g.
// "བཀྲ་ཤིས་བདེ་ལེགས། (Hello!)" -> [{tibetan:true,...}, {tibetan:false,text:"(Hello!)"}].
// Spaces and punctuation stay with the run they're in. Stray foreign letters
// inside Tibetan (shorter than 3 letters, e.g. a model glitch) stay Tibetan;
// the Tibetan voice drops characters it can't say.
export function splitByScript(text) {
    const runs = [];
    for (const ch of text) {
        const kind = isTibetanChar(ch) ? true : isWordChar(ch) ? false : null;
        const last = runs[runs.length - 1];
        if (last && (kind === null || kind === last.tibetan)) last.text += ch;
        else runs.push({ tibetan: kind ?? false, text: ch });
    }
    // Fold short foreign runs next to Tibetan into it, then merge neighbours.
    const letters = (r) => [...r.text].filter(isWordChar).length;
    runs.forEach((r, i) => {
        if (!r.tibetan && letters(r) < 3 && (runs[i - 1]?.tibetan || runs[i + 1]?.tibetan)) r.tibetan = true;
    });
    const merged = [];
    for (const run of runs) {
        const prev = merged[merged.length - 1];
        if (prev && prev.tibetan === run.tibetan) prev.text += run.text;
        else merged.push({ ...run });
    }
    return merged.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => [...r.text].some(isWordChar));
}
