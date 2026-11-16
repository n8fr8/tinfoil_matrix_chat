// Loads and validates configuration from environment variables.
// Env is populated by `node --env-file-if-exists=.env` (see package.json scripts)
// or by the real process environment in production.

import path from "node:path";

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

// Settings that belong to one account and never fall back to the first
// account's value (another account must not log in as, or look like, the first).
const ACCOUNT_ONLY = [
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_USERNAME",
    "MATRIX_PASSWORD",
    "MATRIX_CROSS_SIGNING_KEY",
    "MATRIX_DISPLAY_NAME",
    "MATRIX_STORAGE_PATH",
    "MATRIX_CRYPTO_PATH",
    "MATRIX_CREDENTIALS_PATH",
];

// Account IDs become variable prefixes (TUTOR_MATRIX_USERNAME), so they can't
// be the first word of an existing setting.
const RESERVED_IDS = new Set(["matrix", "chat", "tinfoil", "web", "wiki", "pdf", "media", "voice", "speech", "prompts", "prompt", "health", "file"]);

/** The account IDs in MATRIX_ACCOUNTS; one account ("main") when unset. */
export function accountIds(env = process.env) {
    const ids = (env.MATRIX_ACCOUNTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return ids.length ? ids : ["main"];
}

/** The variable name an account reads a setting from: TUTOR_MATRIX_USERNAME. The first account uses the plain name. */
export function accountVar(id, name, primary) {
    return primary ? name : `${id.toUpperCase()}_${name}`;
}

// The environment as one account sees it: its own <ID>_ variables override the
// plain ones; ACCOUNT_ONLY settings don't fall back.
function accountEnv(env, id, primary) {
    if (primary) return env;
    const prefix = `${id.toUpperCase()}_`;
    const out = { ...env };
    for (const k of ACCOUNT_ONLY) delete out[k];
    for (const [k, v] of Object.entries(env)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
}

const list = (value) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);

// "@bob:example.org" or "bob" on https://example.org -> "bob@example.org", to spot one account listed twice.
function accountKey(account) {
    let host = account.homeserverUrl || "";
    try {
        host = new URL(host).hostname;
    } catch {}
    const m = (account.username || "").match(/^@?([^:]+)(?::(.+))?$/);
    return m ? `${m[1].toLowerCase()}@${(m[2] || host).toLowerCase()}` : null;
}

function loadAccount(baseEnv, id, primary, dataDir) {
    const env = accountEnv(baseEnv, id, primary);
    const accountPath = (name, file) => env[name] || (primary ? `./data/${file}` : path.join(dataDir, id, file));
    return {
        id,
        primary,
        // Log lines of the other accounts say which account they're about.
        logModule: primary ? "melong" : `melong:${id}`,

        // --- Matrix homeserver / identity ---
        homeserverUrl: env.MATRIX_HOMESERVER_URL,
        accessToken: env.MATRIX_ACCESS_TOKEN || "",
        username: env.MATRIX_USERNAME || "",
        password: env.MATRIX_PASSWORD || "",
        deviceName: env.MATRIX_DEVICE_NAME || "melong-bot",
        // Name shown for the bot in rooms. Set on startup; empty leaves it unchanged.
        displayName: (env.MATRIX_DISPLAY_NAME || "").trim(),

        // --- Local persistence --- (other accounts: under data/<id>/)
        storagePath: accountPath("MATRIX_STORAGE_PATH", "bot.json"),
        cryptoPath: accountPath("MATRIX_CRYPTO_PATH", "crypto"),
        credentialsPath: accountPath("MATRIX_CREDENTIALS_PATH", "credentials.json"),

        // --- Behaviour ---
        autojoin: bool(env.MATRIX_AUTOJOIN, true),
        encryption: bool(env.MATRIX_ENCRYPTION, true),
        // Private cross-signing keys (from `npm run cross-signing`); the bot signs
        // each new device with them so other users' clients trust it.
        crossSigningKey: (env.MATRIX_CROSS_SIGNING_KEY || "").trim(),
        // When set (e.g. "!ai"), the bot only replies to messages that start with
        // the prefix. When empty, it replies to every text message in rooms it is in.
        commandPrefix: env.MATRIX_COMMAND_PREFIX ?? "",
        // After a fresh password login, delete this account's other devices that
        // have the same device name. Useful when storage doesn't survive restarts
        // (each restart logs in as a new device).
        cleanupOldDevices: bool(env.MATRIX_CLEANUP_OLD_DEVICES, false),

        // --- Attachments ---
        // Per-room wikis (src/wiki.js). Empty key = wiki commands are off.
        wikiKey: (env.WIKI_ENCRYPTION_KEY || "").trim(),
        wikiMaxBytes: (env.WIKI_MAX_MB ? Number(env.WIKI_MAX_MB) : 20) * 1024 * 1024,
        // PDF documents on request (create_pdf tool); needs WeasyPrint (in the image).
        pdfDocuments: bool(env.PDF_DOCUMENTS, true),
        // inspect_media tool: C2PA, metadata and ProofMode checks of attachments; needs c2patool and exiftool (in the image).
        mediaForensics: bool(env.MEDIA_FORENSICS, true),
        // Longer replies are split into several messages.
        messageMaxChars: env.CHAT_MESSAGE_MAX_CHARS ? Number(env.CHAT_MESSAGE_MAX_CHARS) : 1500,
        // Pause (with "typing" shown) between the messages of a long reply. 0 = send at once.
        messageDelayMs: (env.CHAT_MESSAGE_DELAY_SECONDS ? Number(env.CHAT_MESSAGE_DELAY_SECONDS) : 10) * 1000,
        // Voice replies are split into several voice messages of at most this
        // many characters (voxtral-tts accepts at most 2000; ~600 is ~50 s).
        voiceMaxChars: Math.min(env.VOICE_MESSAGE_MAX_CHARS ? Number(env.VOICE_MESSAGE_MAX_CHARS) : 600, 2000),
        // Files larger than this are refused (Tinfoil's document limit is 50 MB).
        maxAttachmentBytes: (env.CHAT_MAX_ATTACHMENT_MB ? Number(env.CHAT_MAX_ATTACHMENT_MB) : 25) * 1024 * 1024,
        // Zip archives (e.g. ProofMode proof bundles) and videos aren't sent to the model whole, so they may be larger.
        maxArchiveBytes: (env.CHAT_MAX_ARCHIVE_MB ? Number(env.CHAT_MAX_ARCHIVE_MB) : 100) * 1024 * 1024,

        // --- Chat via Tinfoil private inference ---
        chat: {
            ...loadChatConfig(env),
            // Topic prompts this account may use (names from prompts/); empty = all.
            topics: list(env.CHAT_PROMPTS),
            // A topic whose guidance is always added (e.g. a tutor that always teaches).
            defaultTopic: (env.CHAT_DEFAULT_TOPIC || "").trim(),
        },
    };
}

function validateAccount(a, baseEnv, errors) {
    const v = (name) => accountVar(a.id, name, a.primary);
    const e = (msg) => errors.push(msg);
    if (!a.homeserverUrl) e(`${v("MATRIX_HOMESERVER_URL")} is required`);
    if (!a.accessToken && !(a.username && a.password)) {
        e(`Provide ${v("MATRIX_ACCESS_TOKEN")}, or ${v("MATRIX_USERNAME")} + ${v("MATRIX_PASSWORD")} for password login`);
    }
    if (Number.isNaN(a.chat.maxNewTokens)) e(`${v("CHAT_MAX_NEW_TOKENS")} must be a number`);
    if (Number.isNaN(a.maxAttachmentBytes)) e(`${v("CHAT_MAX_ATTACHMENT_MB")} must be a number`);
    if (!(a.wikiMaxBytes > 0)) e(`${v("WIKI_MAX_MB")} must be a positive number`);
    if (!(a.messageDelayMs >= 0)) e(`${v("CHAT_MESSAGE_DELAY_SECONDS")} must be a number, 0 or more`);
    if (!(a.messageMaxChars >= 200)) e(`${v("CHAT_MESSAGE_MAX_CHARS")} must be a number of at least 200`);
    if (!(a.voiceMaxChars >= 100)) e(`${v("VOICE_MESSAGE_MAX_CHARS")} must be a number from 100 to 2000`);
    if (Number.isNaN(a.chat.historyTurns)) e(`${v("CHAT_HISTORY_TURNS")} must be a number`);
}

/**
 * Settings for the whole instance plus one entry per Matrix account
 * (MATRIX_ACCOUNTS; see docs/multi-account-spec.md). Each account entry has
 * every per-account setting, so code that handles messages needs only it.
 */
export function loadConfig(env = process.env) {
    const errors = [];
    const ids = accountIds(env);
    for (const id of ids) {
        if (!/^[a-z][a-z0-9]{0,15}$/.test(id)) errors.push(`MATRIX_ACCOUNTS: "${id}" must be letters and digits, starting with a letter (at most 16)`);
        else if (RESERVED_IDS.has(id)) errors.push(`MATRIX_ACCOUNTS: "${id}" can't be used as an account ID (it is the start of other settings)`);
    }
    const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupId) errors.push(`MATRIX_ACCOUNTS lists "${dupId}" twice`);

    const dataDir = path.dirname(env.MATRIX_STORAGE_PATH || "./data/bot.json");
    const accounts = errors.length ? [] : ids.map((id, i) => loadAccount(env, id, i === 0, dataDir));
    for (const a of accounts) validateAccount(a, env, errors);
    const seen = new Map();
    for (const a of accounts) {
        const key = a.accessToken ? null : accountKey(a);
        if (key && seen.has(key)) errors.push(`Accounts "${seen.get(key)}" and "${a.id}" are the same Matrix account (${key})`);
        else if (key) seen.set(key, a.id);
    }

    const config = {
        accounts,
        logLevel: env.MATRIX_LOG_LEVEL || "INFO",
        // Port for the HTTP status endpoint (needed in Tinfoil Containers). Off when unset.
        healthPort: env.HEALTH_PORT ? Number(env.HEALTH_PORT) : 0,
    };
    if (!env.TINFOIL_API_KEY) errors.push("TINFOIL_API_KEY is required");
    if (Number.isNaN(config.healthPort)) errors.push("HEALTH_PORT must be a number");

    if (errors.length) {
        throw new Error("Invalid configuration:\n  - " + errors.join("\n  - "));
    }
    return config;
}
