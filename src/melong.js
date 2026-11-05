// General-purpose chat client backed by Tinfoil private inference.
//
// Tinfoil runs open-source models inside secure hardware enclaves. The SDK is a
// drop-in replacement for the OpenAI client and verifies enclave attestation
// and code provenance on every connection. It reads TINFOIL_API_KEY from the
// environment, so the key is never passed in code.
//
// Recent messages are kept in memory per conversation (e.g. per Matrix room)
// so the bot can follow along. History is lost when the bot restarts.

import { TinfoilAI } from "tinfoil";

export const DEFAULT_SYSTEM_PROMPT =
    "You are a friendly, knowledgeable assistant chatting in a Matrix room. " +
    "Help with any topic people bring up. Keep replies clear and conversational, " +
    "and reply in the language the user writes in.";

export class ChatClient {
    constructor({
        model = "gemma4-31b",
        maxNewTokens = 2048,
        systemPrompt,
        historyTurns = 10,
        timeoutMs = 120000,
        client,
    } = {}) {
        this.model = model;
        this.maxNewTokens = maxNewTokens;
        this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
        // Number of past user/assistant exchanges to remember per conversation.
        this.historyTurns = historyTurns;
        this.timeoutMs = timeoutMs;
        this.client = client || new TinfoilAI();
        this.histories = new Map();
    }

    reset(conversationId) {
        this.histories.delete(conversationId);
    }

    /**
     * Send a user message and return the assistant's reply.
     * @param {string} conversationId key for remembered history (e.g. room ID)
     * @param {string} text the user's message
     * @param {{signal?: AbortSignal}} [opts]
     */
    async chat(conversationId, text, opts = {}) {
        const history = this.histories.get(conversationId) || [];
        const userMsg = { role: "user", content: text };

        let completion;
        try {
            completion = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: [{ role: "system", content: this.systemPrompt }, ...history, userMsg],
                    max_tokens: this.maxNewTokens,
                },
                { timeout: this.timeoutMs, signal: opts.signal },
            );
        } catch (err) {
            throw new Error(`Tinfoil request failed: ${err?.message || err}`);
        }

        const out = (completion?.choices?.[0]?.message?.content ?? "").toString().trim();
        if (!out) throw new Error("Tinfoil returned an empty response: " + JSON.stringify(completion).slice(0, 300));

        // Remember this exchange, trimmed to the last N turns.
        const updated = [...history, userMsg, { role: "assistant", content: out }];
        this.histories.set(conversationId, updated.slice(-this.historyTurns * 2));
        return out;
    }
}
