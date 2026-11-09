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

// True when most letters in the text are Tibetan script (U+0F00-U+0FFF).
export function isMostlyTibetan(text) {
    const letters = [...text].filter((ch) => /\p{L}|\p{M}/u.test(ch));
    if (!letters.length) return false;
    const tibetan = letters.filter((ch) => ch >= "ༀ" && ch <= "࿿").length;
    return tibetan / letters.length > 0.5;
}
