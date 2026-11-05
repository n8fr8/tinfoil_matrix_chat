// Loads and validates configuration from environment variables.
// Env is populated by `node --env-file-if-exists=.env` (see package.json scripts)
// or by the real process environment in production.

function bool(value, fallback) {
    if (value === undefined) return fallback;
    return !/^(0|false|no|off)$/i.test(value.trim());
}

// Builds just the Melong endpoint config. Separated so `npm run probe` can use
// it without requiring the Matrix credentials.
export function loadMelongConfig(env = process.env) {
    return {
        endpointUrl: env.MELONG_ENDPOINT_URL,
        // HF endpoints are usually token-protected; HF_TOKEN is the conventional name.
        token: env.MELONG_API_TOKEN || env.HF_TOKEN || "",
        maxNewTokens: env.MELONG_MAX_NEW_TOKENS ? Number(env.MELONG_MAX_NEW_TOKENS) : 256,
        // {text} is replaced with the user's message. Mirrors the model card example.
        promptTemplate:
            env.MELONG_PROMPT_TEMPLATE ||
            "Please translate the following text into Tibetan: {text} Translation: ",
        // For "hf" mode: "messages" sends a chat array, "text" sends a raw string.
        inputMode: env.MELONG_INPUT_MODE === "text" ? "text" : "messages",
        // Wire protocol: "openai" (/v1/chat/completions), "hf" (root {inputs}), "tgi" (/generate).
        apiMode: env.MELONG_API_MODE || "openai",
        // Model name sent in "openai" mode. vLLM requires it to match the served model.
        model: env.MELONG_MODEL || "TenzinGayche/Monlam_Melong_preview",
        timeoutMs: env.MELONG_TIMEOUT_MS ? Number(env.MELONG_TIMEOUT_MS) : 60000,
    };
}

export function loadConfig() {
    const env = process.env;

    const config = {
        // --- Matrix homeserver / identity ---
        homeserverUrl: env.MATRIX_HOMESERVER_URL,
        accessToken: env.MATRIX_ACCESS_TOKEN || "",
        username: env.MATRIX_USERNAME || "",
        password: env.MATRIX_PASSWORD || "",
        deviceName: env.MATRIX_DEVICE_NAME || "melong-bot",

        // --- Local persistence ---
        storagePath: env.MATRIX_STORAGE_PATH || "./data/bot.json",
        cryptoPath: env.MATRIX_CRYPTO_PATH || "./data/crypto",
        credentialsPath: env.MATRIX_CREDENTIALS_PATH || "./data/credentials.json",

        // --- Behaviour ---
        autojoin: bool(env.MATRIX_AUTOJOIN, true),
        encryption: bool(env.MATRIX_ENCRYPTION, true),
        // When set (e.g. "!tr"), the bot only translates messages that start with
        // the prefix. When empty, it translates every text message in rooms it is in.
        commandPrefix: env.MATRIX_COMMAND_PREFIX ?? "",
        logLevel: env.MATRIX_LOG_LEVEL || "INFO",

        // --- Melong Hugging Face inference endpoint ---
        melong: loadMelongConfig(env),
    };

    const errors = [];
    if (!config.homeserverUrl) errors.push("MATRIX_HOMESERVER_URL is required");
    if (!config.accessToken && !(config.username && config.password)) {
        errors.push(
            "Provide MATRIX_ACCESS_TOKEN, or MATRIX_USERNAME + MATRIX_PASSWORD for password login",
        );
    }
    if (!config.melong.endpointUrl) errors.push("MELONG_ENDPOINT_URL is required");
    if (Number.isNaN(config.melong.maxNewTokens)) errors.push("MELONG_MAX_NEW_TOKENS must be a number");

    if (errors.length) {
        throw new Error("Invalid configuration:\n  - " + errors.join("\n  - "));
    }

    return config;
}
