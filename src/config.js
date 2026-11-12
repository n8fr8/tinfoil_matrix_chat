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
        model: env.TINFOIL_MODEL || "deepseek-v4-1-flash",
        // Leave room for the model's thinking + the answer.
        // Includes the model's reasoning ("thinking") tokens: thinking models can use
        // ~1,500 thinking a Tibetan answer through, and more on hard requests.
        maxNewTokens: env.CHAT_MAX_NEW_TOKENS ? Number(env.CHAT_MAX_NEW_TOKENS) : 16000,
        // Optional override for the bot's personality / instructions.
        systemPrompt: env.CHAT_SYSTEM_PROMPT || "",
        // How many past exchanges to remember per room (0 = no memory).
        historyTurns: env.CHAT_HISTORY_TURNS ? Number(env.CHAT_HISTORY_TURNS) : 10,
        timeoutMs: env.CHAT_TIMEOUT_MS ? Number(env.CHAT_TIMEOUT_MS) : 300000,
        // Speech-to-text model used for audio attachments and voice messages.
        transcriptionModel: env.TINFOIL_TRANSCRIPTION_MODEL || "voxtral-small-24b",
        // Text-to-speech for voice replies. The voice must belong to the model
        // (see .env.example for both models' voice lists).
        ttsModel: env.TINFOIL_TTS_MODEL || "voxtral-tts",
        ttsVoice: env.TINFOIL_TTS_VOICE || "neutral_female",
        // Tibetan speech sidecar (speech/), e.g. http://speech:8000. Empty = off.
        speechUrl: (env.SPEECH_URL || "").trim(),
        // Who transcribes voice notes when the sidecar is on: "auto" (Tibetan
        // speech -> sidecar, other languages -> SPEECH_DETECT_MODEL), "tibetan"
        // (sidecar only) or "general" (TINFOIL_TRANSCRIPTION_MODEL only).
        speechStt: (env.SPEECH_STT || "auto").trim().toLowerCase(),
        detectModel: env.SPEECH_DETECT_MODEL || "whisper-large-v3-turbo",
        // Whisper confidence (mean log-probability) above which speech is
        // treated as not Tibetan.
        detectThreshold: env.SPEECH_DETECT_THRESHOLD ? Number(env.SPEECH_DETECT_THRESHOLD) : -0.45,
        // Let the model search the web (Tinfoil web search) when it needs to.
        webSearch: !/^(false|0|no|off)$/i.test((env.WEB_SEARCH || "true").trim()),
        // Folder of topic prompts (see prompts/README.md); empty turns them off.
        promptsDir: env.PROMPTS_DIR ?? "./prompts",
        // Model that picks the topic for each message (default: TINFOIL_MODEL).
        classifierModel: env.PROMPT_CLASSIFIER_MODEL || env.TINFOIL_MODEL || "deepseek-v4-1-flash",
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
        // Name shown for the bot in rooms. Set on startup; empty leaves it unchanged.
        displayName: (env.MATRIX_DISPLAY_NAME || "").trim(),

        // --- Local persistence ---
        storagePath: env.MATRIX_STORAGE_PATH || "./data/bot.json",
        cryptoPath: env.MATRIX_CRYPTO_PATH || "./data/crypto",
        credentialsPath: env.MATRIX_CREDENTIALS_PATH || "./data/credentials.json",

        // --- Behaviour ---
        autojoin: bool(env.MATRIX_AUTOJOIN, true),
        encryption: bool(env.MATRIX_ENCRYPTION, true),
        // Private cross-signing keys (from `npm run cross-signing`); the bot signs
        // each new device with them so other users' clients trust it.
        crossSigningKey: (env.MATRIX_CROSS_SIGNING_KEY || "").trim(),
        // When set (e.g. "!ai"), the bot only replies to messages that start with
        // the prefix. When empty, it replies to every text message in rooms it is in.
        commandPrefix: env.MATRIX_COMMAND_PREFIX ?? "",
        logLevel: env.MATRIX_LOG_LEVEL || "INFO",
        // Port for the HTTP status endpoint (needed in Tinfoil Containers). Off when unset.
        healthPort: env.HEALTH_PORT ? Number(env.HEALTH_PORT) : 0,
        // After a fresh password login, delete this account's other devices that
        // have the same device name. Useful when storage doesn't survive restarts
        // (each restart logs in as a new device).
        cleanupOldDevices: bool(env.MATRIX_CLEANUP_OLD_DEVICES, false),

        // --- Attachments ---
        // Files larger than this are refused (Tinfoil's document limit is 50 MB).
        // Per-room wikis (src/wiki.js). Empty key = wiki commands are off.
        wikiKey: (env.WIKI_ENCRYPTION_KEY || "").trim(),
        wikiMaxBytes: (env.WIKI_MAX_MB ? Number(env.WIKI_MAX_MB) : 20) * 1024 * 1024,
        // PDF documents on request (create_pdf tool); needs WeasyPrint (in the image).
        pdfDocuments: bool(env.PDF_DOCUMENTS, true),
        // inspect_media tool: C2PA, metadata and ProofMode checks of attachments; needs c2patool and exiftool (in the image).
        mediaForensics: bool(env.MEDIA_FORENSICS, true),
        // Longer replies are split into several messages.
        messageMaxChars: env.CHAT_MESSAGE_MAX_CHARS ? Number(env.CHAT_MESSAGE_MAX_CHARS) : 1500,
        // Voice replies are split into several voice messages of at most this
        // many characters (voxtral-tts accepts at most 2000; ~600 is ~50 s).
        voiceMaxChars: Math.min(env.VOICE_MESSAGE_MAX_CHARS ? Number(env.VOICE_MESSAGE_MAX_CHARS) : 600, 2000),
        maxAttachmentBytes: (env.CHAT_MAX_ATTACHMENT_MB ? Number(env.CHAT_MAX_ATTACHMENT_MB) : 25) * 1024 * 1024,

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
    if (Number.isNaN(config.healthPort)) errors.push("HEALTH_PORT must be a number");
    if (Number.isNaN(config.maxAttachmentBytes)) errors.push("CHAT_MAX_ATTACHMENT_MB must be a number");
    if (!(config.wikiMaxBytes > 0)) errors.push("WIKI_MAX_MB must be a positive number");
    if (!(config.messageMaxChars >= 200)) errors.push("CHAT_MESSAGE_MAX_CHARS must be a number of at least 200");
    if (!(config.voiceMaxChars >= 100)) errors.push("VOICE_MESSAGE_MAX_CHARS must be a number from 100 to 2000");
    if (Number.isNaN(config.chat.historyTurns)) errors.push("CHAT_HISTORY_TURNS must be a number");

    if (errors.length) {
        throw new Error("Invalid configuration:\n  - " + errors.join("\n  - "));
    }

    return config;
}
