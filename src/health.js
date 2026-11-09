// Tiny HTTP status endpoint. Tinfoil Containers route traffic to an HTTP port
// (the "shim"), and it doubles as a container healthcheck. It reports only
// non-sensitive status, since it is publicly reachable.
//
//   /, /health  bot status (200 when syncing, 503 otherwise)
//   /diag       outbound connectivity check (DNS + TLS) to the hosts the bot
//               needs; results are cached for a minute.
//   /diag?inference=1
//               also runs a tiny end-to-end Tinfoil inference test (see
//               diag-inference.js); at most once every 5 minutes.
//   /diag?speech=1
//               also round-trips a Tibetan sentence through the speech sidecar
//               (TTS -> voice-note encoding -> STT); at most once a minute.

import http from "node:http";
import tls from "node:tls";
import dns from "node:dns/promises";
import { LogService } from "matrix-bot-sdk";
import { runInferenceDiagnostics } from "./diag-inference.js";
import { SpeechSidecar } from "./speech.js";
import { toVoiceMessage } from "./media.js";

const DIAG_TTL_MS = 60 * 1000;
const INFERENCE_DIAG_TTL_MS = 5 * 60 * 1000;

export function startHealthServer(port, getStatus, getDiagHosts = () => []) {
    let diagCache = null;
    let inferenceCache = null;
    let speechCache = null;

    const server = http.createServer(async (req, res) => {
        const send = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(obj, null, 2));
        };
        try {
            if (req.url?.startsWith("/diag")) {
                if (!diagCache || Date.now() - diagCache.at > DIAG_TTL_MS) {
                    diagCache = { at: Date.now(), promise: runDiagnostics(getDiagHosts()) };
                }
                const body = { checkedAt: new Date(diagCache.at).toISOString(), results: await diagCache.promise };
                if (new URL(req.url, "http://x").searchParams.has("inference")) {
                    if (!inferenceCache || Date.now() - inferenceCache.at > INFERENCE_DIAG_TTL_MS) {
                        inferenceCache = { at: Date.now(), promise: runInferenceDiagnostics() };
                    }
                    body.inference = { checkedAt: new Date(inferenceCache.at).toISOString(), steps: await inferenceCache.promise };
                }
                if (new URL(req.url, "http://x").searchParams.has("speech")) {
                    if (!speechCache || Date.now() - speechCache.at > DIAG_TTL_MS) {
                        speechCache = { at: Date.now(), promise: runSpeechDiagnostics() };
                    }
                    body.speech = { checkedAt: new Date(speechCache.at).toISOString(), ...(await speechCache.promise) };
                }
                return send(200, body);
            }
            const status = getStatus();
            send(status.ok ? 200 : 503, status);
        } catch (err) {
            send(500, { error: String(err?.message || err) });
        }
    });
    server.listen(port, "0.0.0.0", () => LogService.info("melong", `Status endpoint listening on 0.0.0.0:${port}`));
    return server;
}

async function runDiagnostics(hosts) {
    return Promise.all([...new Set(hosts)].map(checkHost));
}

// Resolves a host and opens a TLS connection to it on port 443.
async function checkHost(host) {
    const result = { host };
    try {
        result.addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
        return { ...result, ok: false, stage: "dns", error: err.code || err.message };
    }
    const start = Date.now();
    return new Promise((resolve) => {
        const socket = tls.connect({ host, port: 443, servername: host, timeout: 8000 });
        const done = (extra) => {
            socket.destroy();
            resolve({ ...result, ms: Date.now() - start, ...extra });
        };
        socket.once("secureConnect", () => done({ ok: true, stage: "tls" }));
        socket.once("timeout", () => done({ ok: false, stage: "connect", error: "timed out after 8s" }));
        socket.once("error", (err) => done({ ok: false, stage: "connect", error: err.code || err.message }));
    });
}

const SPEECH_TEST_TEXT = "ཁྱེད་རང་སྐུ་གཟུགས་བདེ་པོ་ཡིན་པས།";

// Speaks a fixed Tibetan sentence, encodes it like a Matrix voice message
// (Ogg/Opus) and transcribes it back. Only fixed text, so safe to expose.
async function runSpeechDiagnostics() {
    if (!process.env.SPEECH_URL) return { ok: false, error: "SPEECH_URL not set" };
    const speech = new SpeechSidecar(process.env.SPEECH_URL, { timeoutMs: 60000 });
    const start = Date.now();
    try {
        const wav = await speech.tts(SPEECH_TEST_TEXT);
        const ttsMs = Date.now() - start;
        const voice = await toVoiceMessage(wav);
        const sttStart = Date.now();
        const transcript = await speech.stt(voice.data);
        return { ok: transcript.length > 5, said: SPEECH_TEST_TEXT, heard: transcript, ttsMs, sttMs: Date.now() - sttStart, audioMs: voice.durationMs };
    } catch (err) {
        return { ok: false, ms: Date.now() - start, error: String(err?.message || err) };
    }
}
