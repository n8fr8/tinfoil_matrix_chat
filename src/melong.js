// Client for the Melong (TenzinGayche/Melong_preview) Hugging Face inference
// endpoint. Talks to the endpoint over plain HTTP using the built-in fetch().
//
// HF Inference Endpoints can be served by different containers, each with its
// own request path + body shape. We support the three common ones via apiMode:
//
//   "hf"      POST <url>                    {inputs, parameters:{max_new_tokens}}
//             (default transformers toolkit / TGI legacy protocol)
//   "openai"  POST <url>/v1/chat/completions {model, messages, max_tokens}
//             (TGI messages API / vLLM — returns {choices:[{message:{content}}]})
//   "tgi"     POST <url>/generate            {inputs:"<string>", parameters:{max_new_tokens}}
//
// A 404 with {"detail":"Not Found"} usually means the path is wrong for the
// container (e.g. an OpenAI/vLLM server only routes /v1/chat/completions).
// Use `npm run probe` to discover which mode your endpoint accepts.

export const API_MODES = ["hf", "openai", "tgi"];

export class MelongClient {
    constructor({
        endpointUrl,
        token,
        maxNewTokens = 256,
        promptTemplate,
        inputMode = "messages",
        apiMode = "hf",
        model = "tgi",
        timeoutMs = 60000,
    }) {
        if (!endpointUrl) throw new Error("MelongClient: endpointUrl is required");
        this.endpointUrl = endpointUrl.replace(/\/+$/, "");
        this.token = token;
        this.maxNewTokens = maxNewTokens;
        this.promptTemplate = promptTemplate || "Please translate the following text into Tibetan: {text} Translation: ";
        this.inputMode = inputMode;
        this.apiMode = API_MODES.includes(apiMode) ? apiMode : "hf";
        this.model = model;
        this.timeoutMs = timeoutMs;
    }

    buildPrompt(text) {
        return this.promptTemplate.includes("{text}")
            ? this.promptTemplate.replaceAll("{text}", text)
            : this.promptTemplate + text;
    }

    // Appends a path unless the URL already ends with it.
    withPath(path) {
        return this.endpointUrl.endsWith(path) ? this.endpointUrl : this.endpointUrl + path;
    }

    // Resolves the chat-completions URL, tolerating a base that already includes
    // "/v1" or the full "/v1/chat/completions" (HF gives you the ".../v1/" base).
    openAiUrl() {
        const base = this.endpointUrl; // trailing slashes already stripped in the constructor
        if (base.endsWith("/chat/completions")) return base;
        if (base.endsWith("/v1")) return base + "/chat/completions";
        return base + "/v1/chat/completions";
    }

    // Builds the {url, body} for the configured apiMode.
    buildRequest(text) {
        const prompt = this.buildPrompt(text);
        switch (this.apiMode) {
            case "openai":
                return {
                    url: this.openAiUrl(),
                    body: {
                        model: this.model,
                        messages: [{ role: "user", content: prompt }],
                        max_tokens: this.maxNewTokens,
                    },
                };
            case "tgi":
                return {
                    url: this.withPath("/generate"),
                    body: { inputs: prompt, parameters: { max_new_tokens: this.maxNewTokens } },
                };
            case "hf":
            default:
                return {
                    url: this.endpointUrl,
                    body: {
                        inputs: this.inputMode === "text" ? prompt : [{ role: "user", content: prompt }],
                        parameters: { max_new_tokens: this.maxNewTokens },
                    },
                };
        }
    }

    /**
     * Translate a piece of text. Returns the assistant's reply string.
     * @param {string} text raw user text
     * @param {{signal?: AbortSignal}} [opts]
     */
    async translate(text, opts = {}) {
        const { url, body } = this.buildRequest(text);

        // Honour a caller-provided signal but always enforce our own timeout too.
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
                },
                body: JSON.stringify(body),
                signal,
            });
        } catch (err) {
            if (err?.name === "TimeoutError" || err?.name === "AbortError") {
                throw new Error(`Melong endpoint timed out after ${this.timeoutMs}ms`);
            }
            throw new Error(`Melong endpoint request failed: ${err?.message || err}`);
        }

        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            // 503 from HF usually means a scale-to-zero endpoint is still warming up.
            throw new Error(`Melong endpoint returned ${res.status} ${res.statusText}: ${errBody.slice(0, 500)}`);
        }

        const data = await res.json();
        const out = extractGeneratedText(data);
        if (!out) throw new Error("Melong endpoint returned an empty/unparseable response: " + JSON.stringify(data).slice(0, 300));
        return out;
    }
}

// Pulls the generated text out of the various shapes HF endpoints can return.
export function extractGeneratedText(data) {
    if (typeof data === "string") return data.trim();

    // transformers text-generation pipeline: [{ generated_text: ... }]
    if (Array.isArray(data) && data.length) {
        const first = data[0];
        if (first && "generated_text" in first) {
            const g = first.generated_text;
            if (typeof g === "string") return g.trim();
            // chat output: generated_text is the full conversation; take the last turn.
            if (Array.isArray(g) && g.length) {
                const last = g[g.length - 1];
                return (last?.content ?? "").toString().trim();
            }
        }
    }

    // OpenAI-compatible (TGI messages API / vLLM): { choices: [{ message: { content }}] }
    if (data && Array.isArray(data.choices) && data.choices.length) {
        const choice = data.choices[0];
        return (choice?.message?.content ?? choice?.text ?? "").toString().trim();
    }

    // Single-object pipeline output: { generated_text: "..." }
    if (data && typeof data.generated_text === "string") return data.generated_text.trim();

    return "";
}
