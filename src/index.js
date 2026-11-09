// Matrix chatbot — listens for messages in its rooms and replies using a
// general-purpose AI model via Tinfoil private inference.

import {
    MatrixClient,
    SimpleFsStorageProvider,
    RustSdkCryptoStorageProvider,
    LogService,
    RichConsoleLogger,
    LogLevel,
    RichReply,
} from "matrix-bot-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.js";
import { resolveCredentials } from "./auth.js";
import { ChatClient } from "./melong.js";
import { markdownToMatrixHtml } from "./format.js";
import { startHealthServer } from "./health.js";
import { SpeechSidecar } from "./speech.js";
import {
    MEDIA_MSGTYPES,
    useAuthenticatedMedia,
    attachmentCaption,
    attachmentFilename,
    downloadAttachment,
    toVoiceMessage,
    uploadForRoom,
} from "./media.js";

async function main() {
    const startedAt = Date.now();
    LogService.setLogger(new RichConsoleLogger());
    LogService.setLevel(LogLevel.fromString(process.env.MATRIX_LOG_LEVEL || "INFO"));
    LogService.muteModule("Metrics");

    // Optional status endpoint (required by Tinfoil Containers; see src/health.js).
    // Started before anything else so startup problems are visible on it.
    const status = { started: false, lastSyncAt: 0, error: null };
    const healthPort = Number(process.env.HEALTH_PORT) || 0;
    // Hosts checked by /diag: the homeserver and Tinfoil's API endpoints.
    const diagHosts = () => {
        const hosts = ["inference.tinfoil.sh", "atc.tinfoil.sh"];
        try {
            hosts.unshift(new URL(process.env.MATRIX_HOMESERVER_URL).hostname);
        } catch {}
        return hosts;
    };
    if (healthPort) {
        startHealthServer(healthPort, () => {
            const syncAge = status.lastSyncAt ? Date.now() - status.lastSyncAt : null;
            return {
                ok: status.started && syncAge !== null && syncAge < 5 * 60 * 1000,
                started: status.started,
                secondsSinceLastSync: syncAge === null ? null : Math.round(syncAge / 1000),
                uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
                model: process.env.TINFOIL_MODEL || "deepseek-v4-1-flash",
                ...(status.speechStatus ? { speechSidecar: status.speechStatus } : {}),
                ...(status.error ? { error: status.error } : {}),
            };
        }, diagHosts);
    }

    // Retry startup with backoff. With a status endpoint the process stays up
    // and reports the error there; without one, exit as before.
    for (let attempt = 1, delay = 15000; ; attempt++, delay = Math.min(delay * 2, 5 * 60 * 1000)) {
        try {
            await startBot(status, startedAt);
            status.error = null;
            return;
        } catch (err) {
            status.error = String(err?.body?.error || err?.message || err);
            if (!healthPort) throw err;
            LogService.error("melong", `Startup failed (attempt ${attempt}): ${status.error}. Retrying in ${delay / 1000}s`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

async function startBot(status, startedAt) {
    const config = loadConfig();

    // Fail early, with a clear message, if runtime storage isn't writable
    // (e.g. a container tmpfs owned by a different user).
    await fs.mkdir(path.dirname(config.storagePath), { recursive: true });
    await fs.access(path.dirname(config.storagePath), fs.constants.W_OK).catch(() => {
        throw new Error(
            `Data directory ${path.resolve(path.dirname(config.storagePath))} is not writable by uid ${process.getuid?.()}`,
        );
    });

    const creds = await resolveCredentials(config);
    LogService.info("melong", `Authenticated via ${creds.source}${creds.userId ? ` as ${creds.userId}` : ""}`);

    const storage = new SimpleFsStorageProvider(config.storagePath);

    // The crypto store is bound to a single device. If the access token's device
    // and the store's device disagree, the homeserver rejects the device-key
    // upload ("device_id ... does not match"). Scoping the store by device id
    // keeps each token/device pairing isolated, so swapping tokens never collides.
    let cryptoStore;
    if (config.encryption) {
        const probe = new MatrixClient(config.homeserverUrl, creds.accessToken);
        const deviceId = (await probe.getWhoAmI())?.device_id;
        const cryptoDir = deviceId
            ? path.join(config.cryptoPath, deviceId.replace(/[^A-Za-z0-9._-]/g, "_"))
            : config.cryptoPath;
        await fs.mkdir(cryptoDir, { recursive: true });
        LogService.info("melong", `Encryption enabled; crypto store: ${cryptoDir}`);
        cryptoStore = new RustSdkCryptoStorageProvider(cryptoDir);
    }

    const client = new MatrixClient(config.homeserverUrl, creds.accessToken, storage, cryptoStore);
    stripNullKeyUploadFields(client);
    useAuthenticatedMedia(client);
    // Record successful syncs for the status endpoint.
    const doSync = client.doSync.bind(client);
    client.doSync = async (...args) => {
        try {
            const res = await doSync(...args);
            status.lastSyncAt = Date.now();
            return res;
        } catch (err) {
            // Our device/token was removed (e.g. by another copy of the bot). Exit so
            // the container restarts and logs in fresh, instead of failing forever.
            if (err?.body?.errcode === "M_UNKNOWN_TOKEN" && !err.body.soft_logout) {
                LogService.error("melong", "Access token is no longer valid; exiting so the bot restarts and logs in again");
                await fs.rm(config.credentialsPath, { force: true }).catch(() => {});
                process.exit(1);
            }
            throw err;
        }
    };
    if (config.autojoin) setupAutojoin(client);

    const speech = config.chat.speechUrl ? new SpeechSidecar(config.chat.speechUrl) : null;
    if (speech) {
        // Polled in the background for the status endpoint; doesn't affect "ok".
        const poll = async () => (status.speechStatus = await speech.status());
        poll();
        setInterval(poll, 30000).unref();
    }
    if (speech) LogService.info("melong", `Tibetan speech sidecar: ${config.chat.speechUrl}`);
    const chat = new ChatClient({ ...config.chat, speech });

    // Cache our own user id so we can ignore our own messages without an await per event.
    const botUserId = await client.getUserId();
    if (config.displayName) await applyDisplayName(client, botUserId, config.displayName);

    client.on("room.message", (roomId, event) => {
        // Skip messages sent before the bot started. Without a saved sync token
        // (e.g. a fresh container), the first sync replays recent history.
        if (event?.origin_server_ts && event.origin_server_ts < startedAt) return;
        handleMessage(client, chat, config, botUserId, roomId, event).catch((err) => {
            LogService.error("melong", `Failed to handle message in ${roomId}:`, err);
        });
    });

    if (cryptoStore) {
        client.on("room.failed_decryption", (roomId, event, err) => {
            LogService.warn("melong", `Failed to decrypt an event in ${roomId}:`, err?.message || err);
        });
    }

    await client.start();
    status.started = true;
    LogService.info("melong", `Bot started as ${botUserId} (encryption ${config.encryption ? "on" : "off"})`);

    const shutdown = () => {
        LogService.info("melong", "Shutting down...");
        client.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

// Returns the homeserver part of a Matrix user ID, e.g. "@bob:example.org" -> "example.org".
function serverName(userId) {
    const idx = typeof userId === "string" ? userId.indexOf(":") : -1;
    return idx > 0 ? userId.slice(idx + 1) : undefined;
}

// Auto-accept invites, including DMs. Unlike AutojoinRoomsMixin we pass the
// inviter's homeserver as a "via" hint (required to join rooms over federation
// when the bot and inviter are on different servers) and log the outcome, so a
// failed join is visible instead of silently swallowed.
function setupAutojoin(client) {
    client.on("room.invite", async (roomId, inviteEvent) => {
        const sender = inviteEvent?.sender;
        const isDirect = inviteEvent?.content?.is_direct === true;
        const via = [...new Set([serverName(sender), serverName(inviteEvent?.state_key)].filter(Boolean))];
        LogService.info("melong", `Invited to ${roomId} by ${sender}${isDirect ? " (DM)" : ""}; joining via [${via.join(", ")}]`);
        try {
            await client.joinRoom(roomId, via);
            LogService.info("melong", `Joined ${roomId}`);
        } catch (err) {
            const detail = err?.body ? JSON.stringify(err.body) : err?.message || String(err);
            LogService.error("melong", `Failed to join ${roomId} (status ${err?.statusCode ?? "?"}): ${detail}`);
        }
    });
}

// The Rust crypto engine sends `"device_keys": null` (and similar) when it only
// has one-time keys to upload. Spec-strict homeservers reject null here
// (M_INVALID_PARAM "device_keys must not be null"), which fails every sync.
// Drop null top-level fields from /keys/upload bodies before they are sent.
function stripNullKeyUploadFields(client) {
    const doRequest = client.doRequest.bind(client);
    client.doRequest = (method, endpoint, qs, body, ...rest) => {
        if (method === "POST" && endpoint.endsWith("/keys/upload") && body && typeof body === "object") {
            body = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined));
        }
        return doRequest(method, endpoint, qs, body, ...rest);
    };
}

// Some clients send a placeholder text like "Sent 1 media items." alongside
// (or as the fallback body of) media. It is not a real message, so skip it.
const MEDIA_PLACEHOLDER = /^sent \d+ (media )?items?\.?$/i;

// Strips the command prefix. Returns null when a prefix is set and missing.
function stripPrefix(config, text) {
    if (!config.commandPrefix) return text;
    if (!text.startsWith(config.commandPrefix)) return null;
    return text.slice(config.commandPrefix.length).trim();
}

async function handleMessage(client, chat, config, botUserId, roomId, event) {
    const content = event?.content;
    if (!content || event.sender === botUserId) return; // ignore our own messages
    LogService.debug("melong", `Message ${event.event_id} msgtype=${content.msgtype} keys=${Object.keys(content).join(",")}`);

    const media = mediaItems(content);
    if (media.length) return handleAttachments(client, chat, config, roomId, event, media);
    if (content.msgtype !== "m.text") return;

    let body = (content.body || "").trim();
    if (!body || MEDIA_PLACEHOLDER.test(body)) return;

    // Optional command prefix: only react to "!ai ..." style messages when set.
    body = stripPrefix(config, body);
    if (body === null) return;
    if (!body) {
        await client.replyNotice(roomId, event, `Usage: ${config.commandPrefix} <your message>`);
        return;
    }

    // "!reset" clears the bot's memory of this room.
    if (body === "!reset") {
        chat.reset(roomId);
        await client.replyNotice(roomId, event, "Conversation history cleared.");
        return;
    }

    await respond(client, chat, roomId, event, body, []);
}

// Returns the media in a message: the message itself for m.image/m.audio/
// m.video/m.file, or the items of a multi-media "gallery" message (clients
// put these in an array of objects that each carry their own url/file).
function mediaItems(content) {
    if (MEDIA_MSGTYPES.includes(content.msgtype)) return [content];
    for (const value of Object.values(content)) {
        if (!Array.isArray(value)) continue;
        const items = value.filter((v) => v && typeof v === "object" && (v.url || v.file?.url));
        if (items.length) return items.map((v) => ({ ...v, msgtype: v.msgtype || v.itemtype }));
    }
    return [];
}

async function handleAttachments(client, chat, config, roomId, event, items) {
    const tooBig = items.find((c) => c.info?.size > config.maxAttachmentBytes);
    if (tooBig) {
        if (!config.commandPrefix) {
            const mb = Math.round(config.maxAttachmentBytes / 1024 / 1024);
            await client.replyNotice(roomId, event, `Sorry, "${attachmentFilename(tooBig)}" is too large (limit ${mb} MB).`);
        }
        return;
    }

    // Text sent with the media is the instruction. For a gallery it is the
    // message body; for a single file it is the caption.
    let caption = event.content === items[0] ? attachmentCaption(items[0]) : (event.content.body || "").trim();
    if (MEDIA_PLACEHOLDER.test(caption)) caption = "";
    if (!caption) caption = items.map(attachmentCaption).find(Boolean) || "";

    // With a command prefix set, only respond when the caption starts with it.
    const prompt = stripPrefix(config, caption);
    if (prompt === null) return;

    // No instruction: the chat client falls back to describing / summarising.
    await respond(client, chat, roomId, event, prompt, items);
}

async function respond(client, chat, roomId, event, text, attachmentContents) {
    // Thinking models can take a minute or more: keep the typing notice alive.
    const typing = () => client.setTyping(roomId, true, 60000).catch(() => {});
    typing();
    const keepTyping = setInterval(typing, 45000);
    try {
        const attachments = [];
        for (const c of attachmentContents) attachments.push(await downloadAttachment(client, c));
        const reply = await chat.chat(roomId, text, attachments);
        // Plain Markdown stays in `body` as a fallback; clients render the HTML.
        // Voice replies get this text message too, then the voice message.
        await client.sendMessage(roomId, RichReply.createFor(roomId, event, reply.text, markdownToMatrixHtml(reply.text)));
        if (reply.voice) {
            try {
                await sendVoiceReply(client, chat, roomId, event, reply.text);
            } catch (err) {
                LogService.error("melong", "Voice reply failed:", err?.message || err);
                await client.replyNotice(roomId, event, `(Couldn't create the voice version: ${err?.message || err})`);
            }
        }
    } catch (err) {
        LogService.error("melong", "Chat request failed:", err?.message || err);
        await client.replyNotice(roomId, event, `Sorry, something went wrong: ${err?.message || err}`);
    } finally {
        clearInterval(keepTyping);
        await client.setTyping(roomId, false).catch(() => {});
    }
}

// Speaks `text` with Tinfoil TTS and sends it as a Matrix voice message
// (MSC3245), with the text as a caption so it is still readable.
async function sendVoiceReply(client, chat, roomId, event, text) {
    await client.setTyping(roomId, true, 60000).catch(() => {});
    const voice = await toVoiceMessage(await chat.speak(text));
    const filename = "voice-reply.ogg";
    const media = await uploadForRoom(client, roomId, voice.data, voice.mimetype, filename);
    await client.sendMessage(roomId, {
        msgtype: "m.audio",
        body: text,
        filename,
        ...media,
        info: { mimetype: voice.mimetype, size: voice.data.length, duration: voice.durationMs },
        "org.matrix.msc1767.audio": { duration: voice.durationMs, waveform: voice.waveform },
        "org.matrix.msc3245.voice": {},
        "m.relates_to": { "m.in_reply_to": { event_id: event.event_id } },
    });
}

// Sets the bot's global display name if it differs from the configured one.
// Failures are logged but don't stop the bot.
async function applyDisplayName(client, userId, displayName) {
    try {
        const profile = await client.getUserProfile(userId).catch(() => ({}));
        if (profile?.displayname === displayName) return;
        await client.setDisplayName(displayName);
        LogService.info("melong", `Display name set to "${displayName}"`);
    } catch (err) {
        LogService.warn("melong", `Could not set display name: ${err?.body?.error || err?.message || err}`);
    }
}

main().catch((err) => {
    console.error("Fatal:", err?.message || err);
    process.exit(1);
});
