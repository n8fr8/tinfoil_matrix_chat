// Loads and validates configuration from environment variables.
// Env is populated by `node --env-file-if-exists=.env` (see package.json scripts)
// or by the real process environment in production.

function bool(value, fallback) {
    if (value === undefined) return fallback;
    return !/^(0|false|no|off)$/i.test(value.trim());
}

// Builds just the chat (Tinfoil) config. Separated so `npm run probe` can use
// it without requiring the Matrix credentials. The Tinfoil SDK reads
// TINFOIL_API_KEY from the environment itself.
export function loadChatConfig(env = process.env) {
    return {
        // Model ID from https://docs.tinfoil.sh/models/overview
        model: env.TINFOIL_MODEL || "gemma4-31b",
        // Leave room for the model's thinking + the answer.
        maxNewTokens: env.CHAT_MAX_NEW_TOKENS ? Number(env.CHAT_MAX_NEW_TOKENS) : 2048,
        // Optional override for the bot's personality / instructions.
        systemPrompt: env.CHAT_SYSTEM_PROMPT || "",
        // How many past exchanges to remember per room (0 = no memory).
        historyTurns: env.CHAT_HISTORY_TURNS ? Number(env.CHAT_HISTORY_TURNS) : 10,
        timeoutMs: env.CHAT_TIMEOUT_MS ? Number(env.CHAT_TIMEOUT_MS) : 120000,
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
        // When set (e.g. "!ai"), the bot only replies to messages that start with
        // the prefix. When empty, it replies to every text message in rooms it is in.
        commandPrefix: env.MATRIX_COMMAND_PREFIX ?? "",
        logLevel: env.MATRIX_LOG_LEVEL || "INFO",

        // --- Chat via Tinfoil private inference ---
        chat: loadChatConfig(env),
    };

    const errors = [];
    if (!config.homeserverUrl) errors.push("MATRIX_HOMESERVER_URL is required");
    if (!config.accessToken && !(config.username && config.password)) {
        errors.push(
            "Provide MATRIX_ACCESS_TOKEN, or MATRIX_USERNAME + MATRIX_PASSWORD for password login",
        );
    }
    if (!env.TINFOIL_API_KEY) errors.push("TINFOIL_API_KEY is required");
    if (Number.isNaN(config.chat.maxNewTokens)) errors.push("CHAT_MAX_NEW_TOKENS must be a number");
    if (Number.isNaN(config.chat.historyTurns)) errors.push("CHAT_HISTORY_TURNS must be a number");

    if (errors.length) {
        throw new Error("Invalid configuration:\n  - " + errors.join("\n  - "));
    }

    return config;
}
