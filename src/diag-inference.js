// Inference self-test for /diag?inference=1. Runs each step separately with
// its own timing so a hang can be pinned to one stage:
//   1. plain HTTPS call to Tinfoil (no SDK, no attestation)
//   2. SDK attestation/verification (client.ready())
//   3. tiny chat completion through the SDK, default EHBP transport
//   4. same through the SDK's TLS transport
// Each call asks for ~5 tokens. Callers rate-limit how often this runs.

import { createTinfoilClient } from "./melong.js";

const MODEL = () => process.env.TINFOIL_MODEL || "deepseek-v4-1-flash";
const STEP_TIMEOUT_MS = 45000;

async function step(name, fn) {
    const start = Date.now();
    try {
        const detail = await Promise.race([
            fn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`step timed out after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS)),
        ]);
        return { step: name, ok: true, ms: Date.now() - start, ...(detail ? { detail } : {}) };
    } catch (err) {
        return { step: name, ok: false, ms: Date.now() - start, error: describe(err) };
    }
}

function describe(err) {
    const parts = [err?.name, err?.status, err?.message].filter(Boolean);
    for (let c = err?.cause, depth = 0; c && depth < 4; c = c.cause, depth++) {
        parts.push(`cause: ${[c.name, c.code, c.message].filter(Boolean).join(" ")}`);
    }
    return parts.join(" | ").slice(0, 600);
}

const tinyChat = (client) =>
    client.chat.completions
        .create({ model: MODEL(), messages: [{ role: "user", content: "Reply with just: OK" }], max_tokens: 2000 }, { timeout: STEP_TIMEOUT_MS, maxRetries: 0 })
        .then((r) => ({ reply: r?.choices?.[0]?.message?.content?.slice(0, 40) ?? null }));

export async function runInferenceDiagnostics() {
    const results = [];
    results.push(
        await step("plain-https", async () => {
            const res = await fetch("https://inference.tinfoil.sh/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TINFOIL_API_KEY}` },
                body: JSON.stringify({ model: MODEL(), messages: [{ role: "user", content: "Reply with just: OK" }], max_tokens: 2000 }),
                signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            return { status: res.status };
        }),
    );

    const ehbp = createTinfoilClient({ transport: "ehbp" });
    results.push(await step("sdk-attestation", () => ehbp.ready()));
    results.push(await step("sdk-chat-ehbp", () => tinyChat(ehbp)));
    results.push(await step("sdk-chat-tls", () => tinyChat(createTinfoilClient({ transport: "tls" }))));
    return results;
}
