// Matrix chatbot — listens for messages in its rooms and replies using a
// general-purpose AI model via Tinfoil private inference.

import {
    MatrixClient,
    SimpleFsStorageProvider,
    RustSdkCryptoStorageProvider,
    EncryptedRoomEvent,
    LogService,
    RichConsoleLogger,
    LogLevel,
} from "matrix-bot-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { parseCrossSigningKey, signOwnDevice } from "./cross-signing.js";
import { loadPrompts, PromptLibrary } from "./prompts.js";
import { defaultSchema, WikiStore } from "./wiki.js";
import { pdfAvailable } from "./pdf.js";
import { forensicsTools } from "./forensics.js";
import { resolveCredentials } from "./auth.js";
import { ChatClient, createTinfoilClient, forSpeech } from "./melong.js";
import { splitMessage, weightedLength } from "./split.js";
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
                ...(status.webSearch !== undefined ? { webSearch: status.webSearch } : {}),
                ...(status.crossSigning ? { crossSigning: status.crossSigning } : {}),
                ...(status.prompts ? { prompts: status.prompts } : {}),
                ...(status.wiki !== undefined ? { wiki: status.wiki } : {}),
                ...(status.pdf !== undefined ? { pdf: status.pdf } : {}),
                ...(status.forensics !== undefined ? { mediaForensics: status.forensics || false } : {}),
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
    status.webSearch = config.chat.webSearch;

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
    // Parsed up front so a bad secret fails startup with a clear message.
    const crossSigningKeys = config.encryption && config.crossSigningKey ? parseCrossSigningKey(config.crossSigningKey) : null;
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
    const tinfoil = createTinfoilClient();
    const topicPrompts = config.chat.promptsDir.trim() ? await loadPrompts(config.chat.promptsDir) : [];
    const prompts = topicPrompts.length
        ? new PromptLibrary(topicPrompts, { client: tinfoil, model: config.chat.classifierModel })
        : null;
    status.prompts = prompts?.names ?? [];
    LogService.info("melong", `Topic prompts: ${status.prompts.length ? status.prompts.join(", ") : "none"}`);
    const chat = new ChatClient({
        ...config.chat,
        speech,
        prompts,
        client: tinfoil,
        wikiSchema: await defaultSchema(),
        wikiMaxBytes: config.wikiMaxBytes,
        pdf: (status.pdf = config.pdfDocuments && (await pdfAvailable())),
        forensics: (status.forensics = config.mediaForensics ? await forensicsTools() : null),
    });

    // Cache our own user id so we can ignore our own messages without an await per event.
    const botUserId = await client.getUserId();
    if (config.displayName) await applyDisplayName(client, botUserId, config.displayName);
    // Room wikis are stored encrypted in Matrix; off without WIKI_ENCRYPTION_KEY.
    chat.wikiStore = config.wikiKey ? new WikiStore(client, config.wikiKey, { maxBytes: config.wikiMaxBytes }) : null;
    status.wiki = Boolean(chat.wikiStore);
    LogService.info("melong", `Room wikis: ${chat.wikiStore ? "on" : "off (set WIKI_ENCRYPTION_KEY)"}`);

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
            if (event?.sender === botUserId || (event?.origin_server_ts && event.origin_server_ts < startedAt)) return;
            handleUndecryptable(client, config, roomId, event, (decrypted) =>
                handleMessage(client, chat, config, botUserId, roomId, decrypted),
            ).catch((e) => LogService.error("melong", `Failed to handle an undecryptable message in ${roomId}:`, e?.message || e));
        });
    }

    await client.start();
    status.started = true;
    if (crossSigningKeys) {
        status.crossSigning = await signOwnDevice(client, crossSigningKeys);
    } else if (config.encryption) {
        status.crossSigning = "off";
        LogService.warn(
            "melong",
            "MATRIX_CROSS_SIGNING_KEY is not set: this device isn't cross-signed, so some clients won't share room keys with it after a restart. Run `npm run cross-signing`.",
        );
    }
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
    // Replies quote the original message at the top of the body ("> <@user> ..."); drop it.
    const inReplyTo = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    if (inReplyTo) body = body.replace(/^(>.*(\n|$))+\n*/, "").trim();
    // In a thread, the message it's about is the thread's first message (some
    // clients send a file, then the note about it as a thread reply). Inside a
    // thread, m.in_reply_to is only a real reply when is_falling_back is false.
    const rel = content["m.relates_to"] || {};
    const threadRoot = rel.rel_type === "m.thread" ? rel.event_id : null;
    const target = inReplyTo && !(threadRoot && rel.is_falling_back) ? inReplyTo : threadRoot;
    if (!body || MEDIA_PLACEHOLDER.test(body)) return;

    // Optional command prefix: only react to "!ai ..." style messages when set.
    body = stripPrefix(config, body);
    if (body === null) return;
    if (!body) {
        await replyNotice(client, roomId, event, `Usage: ${config.commandPrefix} <your message>`);
        return;
    }

    // "!reset" clears the bot's memory of this room.
    if (body === "!reset") {
        chat.reset(roomId);
        await replyNotice(client, roomId, event, "Conversation history cleared.");
        return;
    }

    // The message being replied to, so "remember this" (or any question) can refer to it.
    // Files this person just sent without a caption are answered together with
    // this message (claimed first, before any await, so they aren't also answered alone).
    const claimed = claimPendingFiles(roomId, event.sender, target);
    const quoted = target ? await quotedMessage(client, roomId, target) : { text: "", media: [] };
    quoted.media.push(...claimed);

    // !memory (or the older !wiki) commands.
    const wikiCmd = body.match(/^!(?:memory|wiki)(?:\s+([\s\S]*))?$/i);
    if (wikiCmd) return handleWikiCommand(client, chat, config, roomId, event, (wikiCmd[1] || "").trim(), quoted);

    // Tracked so a file that arrives for this message while it is being
    // answered can restart the answer with the file included (see handleAttachments).
    const tracked = { key: `${roomId}|${event.sender}`, event, text: quoted.text + body, media: quoted.media, ts: Date.now(), controller: new AbortController(), sent: false };
    inflight.set(tracked.key, tracked);
    await respond(client, chat, config, roomId, event, tracked.text, tracked.media, { tracked });
}

// m.relates_to for the bot's reply. Replies always go in the main timeline, as
// separate messages: some clients put a voice note or file in a thread under a
// placeholder message, and answering inside that thread hides the answer.
// For a message in a thread, quote the thread's first message (the one shown
// in the timeline). Later parts of a long reply aren't quoted.
function replyRelation(event, first = true) {
    if (!first) return undefined;
    const rel = event?.content?.["m.relates_to"];
    const target = rel?.rel_type === "m.thread" && rel.event_id ? rel.event_id : event.event_id;
    return { "m.in_reply_to": { event_id: target } };
}

function replyContent(event, text, { msgtype = "m.text", first = true } = {}) {
    const relation = replyRelation(event, first);
    return {
        msgtype,
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: markdownToMatrixHtml(text),
        ...(relation ? { "m.relates_to": relation } : {}),
    };
}

function replyNotice(client, roomId, event, text) {
    return client.sendMessage(roomId, replyContent(event, text, { msgtype: "m.notice" }));
}

// A message the bot can't decrypt, nearly always because the sender's app
// hasn't shared the room key with this device (each restart is a new device;
// some apps keep using the old key and never send it on). The key sometimes
// arrives a moment after the message, so retry first; if it never comes, say
// so once per room key instead of staying silent.
const UNDECRYPTABLE_RETRY_MS = [2000, 8000, 20000];
const undecryptableNoticed = new Set();
export const UNDECRYPTABLE_NOTICE =
    "I couldn't read your message. I was restarted, so I'm a new device in this room, and your app hasn't shared " +
    "this room's encryption key with me yet. To fix it, make your app start a new key: in Element (web or desktop), " +
    "type /discardsession in this room, then send your message again. Or start a new room with me.";

async function handleUndecryptable(client, config, roomId, event, onDecrypted, retryMs = UNDECRYPTABLE_RETRY_MS) {
    for (const ms of retryMs) {
        await new Promise((r) => setTimeout(r, ms));
        try {
            const decrypted = (await client.crypto.decryptRoomEvent(new EncryptedRoomEvent(event), roomId)).raw;
            LogService.info("melong", `Decrypted ${event.event_id} after a retry (the room key arrived late)`);
            if (decrypted.type === "m.room.message") await onDecrypted(decrypted);
            return;
        } catch {}
    }
    if (config.commandPrefix) return; // in shared rooms, unreadable messages may not be for the bot
    const key = `${roomId}|${event.content?.session_id || event.content?.sender_key || ""}`;
    if (undecryptableNoticed.has(key)) return;
    undecryptableNoticed.add(key);
    await replyNotice(client, roomId, event, UNDECRYPTABLE_NOTICE);
}

// Fetches a replied-to message: its text as context, or its file as an attachment.
async function quotedMessage(client, roomId, eventId) {
    try {
        const ev = await client.getEvent(roomId, eventId);
        const c = ev?.content || {};
        const media = mediaItems(c);
        if (media.length) return { text: "", media };
        let quoted = (c.body || "").replace(/^(>.*(\n|$))+\n*/, "").trim();
        if (!quoted) return { text: "", media: [] };
        if (quoted.length > 8000) quoted = quoted.slice(0, 8000) + " [...]";
        return { text: `[Replying to this message from ${ev.sender}:]\n${quoted.replace(/^/gm, "> ")}\n\n`, media: [] };
    } catch (err) {
        LogService.warn("melong", `Couldn't fetch the replied-to message ${eventId}: ${err?.message || err}`);
        return { text: "", media: [] };
    }
}

const WIKI_HELP =
    "I can remember things for this room. Just say \"remember this\" (you can also reply to a message or file with it), " +
    "and ask me about it anytime.\n\n" +
    "- `!memory`: this help\n" +
    "- `!memory add <text>`: remember something (or reply to a message or file with `!memory add`)\n" +
    "- `!memory check`: tidy up what I remember and point out anything contradictory\n" +
    "- `!memory export`: download everything I remember for this room, as a zip of text files\n" +
    "- `!memory clear`: forget everything for this room";

async function handleWikiCommand(client, chat, config, roomId, event, args, quoted) {
    const store = chat.wikiStore;
    const notice = (text) => client.sendMessage(roomId, replyContent(event, text));
    if (!store) return notice("Memory isn't set up on this bot (WIKI_ENCRYPTION_KEY is not set).");
    const [sub, ...rest] = args.split(/\s+/);
    const command = (sub || "").toLowerCase();
    try {
        if (command === "" || command === "help") {
            const wiki = await store.withRoom(roomId, async (w) => w);
            const state = wiki.exists ? "" : "I don't remember anything for this room yet.\n\n";
            return notice(`${state}${WIKI_HELP}`);
        }
        if (command === "export") return exportWiki(client, store, roomId, event, notice);
        if (command === "add") {
            const text = args.slice(sub.length).trim();
            if (!text && !quoted.text && !quoted.media.length) return notice("Usage: `!memory add <text>`, or reply to a message or file with `!memory add`.");
            return respond(client, chat, config, roomId, event, quoted.text + (text || "Remember this."), quoted.media, { wikiTask: "add" });
        }
        if (command === "check" || command === "lint") {
            const wiki = await store.withRoom(roomId, async (w) => w);
            if (!wiki.exists) return notice("I don't remember anything for this room yet.");
            return respond(client, chat, config, roomId, event, "Check and tidy up the room's memory.", [], { wikiTask: "lint" });
        }
        if (command === "clear") {
            if ((rest[0] || "").toLowerCase() !== "confirm") {
                return notice("This makes me forget everything I remember for this room, for everyone. To go ahead, send `!memory clear confirm`. (Use `!memory export` first if you want a copy.)");
            }
            await store.withRoom(roomId, () => store.clear(roomId));
            return notice("Done. I've forgotten everything for this room.");
        }
        return notice(`I don't know the command "${sub}".\n\n${WIKI_HELP}`);
    } catch (err) {
        LogService.error("melong", `Wiki command failed in ${roomId}:`, err?.message || err);
        return notice(`Sorry, that didn't work: ${err?.message || err}`);
    }
}

// Sends the room's wiki as a zip (encrypted in encrypted rooms, like any file).
async function exportWiki(client, store, roomId, event, notice) {
    const zip = await store.withRoom(roomId, async (wiki) => (wiki.exists ? wiki.toZip() : null));
    if (!zip) return notice("I don't remember anything for this room yet. Say \"remember this\" to start.");
    let name = "room";
    try {
        name = (await client.getRoomStateEvent(roomId, "m.room.name", ""))?.name || name;
    } catch {}
    const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
    const filename = `memory-${slug}-${new Date().toISOString().slice(0, 10)}.zip`;
    const media = await uploadForRoom(client, roomId, zip, "application/zip", filename);
    await client.sendMessage(roomId, {
        msgtype: "m.file",
        body: filename,
        filename,
        ...media,
        info: { mimetype: "application/zip", size: zip.length },
        "m.relates_to": replyRelation(event),
    });
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

// Zip archives and videos get a larger size limit: they aren't sent to the model
// whole (zips are inspected; videos become frames plus a soundtrack transcript).
const isArchive = (c) =>
    /zip/.test(c.info?.mimetype || "") || /\.zip$/i.test(attachmentFilename(c)) || c.msgtype === "m.video" || /^video\//.test(c.info?.mimetype || "");

async function handleAttachments(client, chat, config, roomId, event, items) {
    const limit = (c) => (isArchive(c) ? config.maxArchiveBytes || config.maxAttachmentBytes : config.maxAttachmentBytes);
    const tooBig = items.find((c) => c.info?.size > limit(c));
    if (tooBig) {
        if (!config.commandPrefix) {
            const mb = Math.round(limit(tooBig) / 1024 / 1024);
            await replyNotice(client, roomId, event, `Sorry, "${attachmentFilename(tooBig)}" is too large (limit ${mb} MB).`);
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

    // No caption: many clients send the note about a file as a separate
    // message just after it (often as a thread reply). Wait briefly for one;
    // if it comes, that message answers both (see claimPendingFiles).
    if (!prompt) {
        const key = `${roomId}|${event.sender}`;
        const rel = event.content?.["m.relates_to"];
        const threadRoot = rel?.rel_type === "m.thread" ? rel.event_id : null;

        // Some clients send the text first and then the file, as a thread reply
        // on that text. If that text is still being answered, restart the answer
        // with the file included.
        const live = inflight.get(key);
        if (live && !live.sent && (threadRoot === live.event.event_id || Date.now() - live.ts < TEXT_THEN_FILE_MS)) {
            live.controller.abort();
            inflight.delete(key);
            LogService.info("melong", `File arrived for a message being answered; answering both together`);
            return respond(client, chat, config, roomId, live.event, live.text, [...live.media, ...items]);
        }
        // Too late for that: answer the file using the text it was attached to.
        if (threadRoot) {
            const root = await client.getEvent(roomId, threadRoot).catch(() => null);
            let rootText = root?.sender === event.sender && root.content?.msgtype === "m.text" ? (root.content.body || "").trim() : "";
            if (MEDIA_PLACEHOLDER.test(rootText)) rootText = ""; // e.g. "Sent 1 media items." above a voice note
            if (rootText) return respond(client, chat, config, roomId, event, stripPrefix(config, rootText) ?? rootText, items);
        }
        // Voice notes and audio don't get a follow-up note: answer right away.
        if (items.every((c) => c.msgtype === "m.audio")) return respond(client, chat, config, roomId, event, "", items);

        const entry = { eventId: event.event_id, items, ts: Date.now() };
        entry.timer = setTimeout(() => {
            removePending(key, entry);
            // No note came: the chat client falls back to describing / summarising.
            respond(client, chat, config, roomId, event, "", items).catch((err) => {
                LogService.error("melong", `Failed to answer a file in ${roomId}:`, err?.message || err);
            });
        }, FILE_NOTE_WAIT_MS);
        pendingFiles.set(key, [...(pendingFiles.get(key) || []), entry]);
        return;
    }
    await respond(client, chat, config, roomId, event, prompt, items);
}

// Text messages being answered, by "room|sender", and how soon after one a
// captionless file (not in its thread) still counts as belonging to it.
const inflight = new Map();
const TEXT_THEN_FILE_MS = 15000;

// Captionless files waiting for a follow-up note, by "room|sender".
const FILE_NOTE_WAIT_MS = Number(process.env.FILE_NOTE_WAIT_MS) || 6000; // shorter in tests
const pendingFiles = new Map();

function removePending(key, entry) {
    const left = (pendingFiles.get(key) || []).filter((e) => e !== entry);
    if (left.length) pendingFiles.set(key, left);
    else pendingFiles.delete(key);
}

// Takes this sender's waiting files (so they aren't answered separately) and
// returns their media. The replied-to file itself is already fetched by the
// caller, so it is left out of the result.
function claimPendingFiles(roomId, sender, targetEventId) {
    const key = `${roomId}|${sender}`;
    const entries = pendingFiles.get(key) || [];
    pendingFiles.delete(key);
    const media = [];
    for (const e of entries) {
        clearTimeout(e.timer);
        if (e.eventId !== targetEventId) media.push(...e.items);
    }
    return media;
}

async function respond(client, chat, config, roomId, event, text, attachmentContents, { wikiTask, tracked } = {}) {
    const signal = tracked?.controller.signal;
    // Thinking models can take a minute or more: keep the typing notice alive.
    const typing = () => client.setTyping(roomId, true, 60000).catch(() => {});
    typing();
    const keepTyping = setInterval(typing, 45000);
    try {
        const attachments = [];
        for (const c of attachmentContents) {
            const a = await downloadAttachment(client, c);
            LogService.info("melong", `Attachment ${a.kind} ${a.mimetype} ${a.data.length} bytes; message declared ${JSON.stringify(a.sent)}`);
            attachments.push(a);
        }
        const reply = await chatWithWiki(chat, roomId, text, attachments, wikiTask, signal);
        // Superseded by a file that arrived for this message: a new answer covers both.
        if (signal?.aborted) return;
        if (tracked) tracked.sent = true;
        // Long replies go out as several messages; the first one is a reply to
        // the user's message. Plain Markdown stays in `body` as a fallback;
        // clients render the HTML. Voice replies get the text too, then voice.
        const parts = splitMessage(reply.text, config.messageMaxChars);
        for (const [i, part] of parts.entries()) {
            await client.sendMessage(roomId, replyContent(event, part, { first: i === 0 }));
        }
        // Documents the model made (create_pdf), as files (encrypted in encrypted rooms).
        for (const f of reply.files || []) {
            try {
                const media = await uploadForRoom(client, roomId, f.data, f.mimetype, f.filename);
                await client.sendMessage(roomId, {
                    msgtype: "m.file",
                    body: f.filename,
                    filename: f.filename,
                    ...media,
                    info: { mimetype: f.mimetype, size: f.data.length },
                });
            } catch (err) {
                LogService.error("melong", `Sending ${f.filename} failed:`, err?.message || err);
                await replyNotice(client, roomId, event, `(Couldn't attach ${f.filename}: ${err?.message || err})`);
            }
        }
        if (reply.voice) {
            try {
                await sendVoiceReplies(client, chat, roomId, event, reply.text, config.voiceMaxChars);
            } catch (err) {
                LogService.error("melong", "Voice reply failed:", err?.message || err);
                await replyNotice(client, roomId, event, `(Couldn't create the voice version: ${err?.message || err})`);
            }
        }
    } catch (err) {
        if (signal?.aborted) return;
        LogService.error("melong", "Chat request failed:", err?.message || err);
        await replyNotice(client, roomId, event, `Sorry, something went wrong: ${err?.message || err}`);
    } finally {
        clearInterval(keepTyping);
        // When superseded, the new answer keeps the typing notice going.
        if (!signal?.aborted) await client.setTyping(roomId, false).catch(() => {});
        if (tracked && inflight.get(tracked.key) === tracked) inflight.delete(tracked.key);
    }
}

// Runs the chat with this room's wiki (one message at a time per room) and
// saves the wiki if it changed. If the wiki can't be loaded, normal messages
// still get an answer without it; !memory commands report the error.
async function chatWithWiki(chat, roomId, text, attachments, wikiTask, signal) {
    const store = chat.wikiStore;
    if (!store) return chat.chat(roomId, text, attachments, { signal });
    try {
        return await store.withRoom(roomId, async (wiki) => {
            try {
                return await chat.chat(roomId, text, attachments, { wiki, wikiTask, signal });
            } finally {
                // Save even if the reply failed, so finished edits aren't lost.
                await store.save(roomId, wiki).catch((err) => {
                    LogService.error("melong", `Saving the wiki for ${roomId} failed:`, err?.message || err);
                });
            }
        });
    } catch (err) {
        if (!err?.wikiLoad || wikiTask) throw err;
        LogService.warn("melong", `Answering without the wiki in ${roomId}: ${err.message}`);
        return chat.chat(roomId, text, attachments, { signal });
    }
}

// Speaks `text` as one or more Matrix voice messages (MSC3245), split so each
// fits the text-to-speech length limit. The next part is synthesized while the
// current one is sent.
async function sendVoiceReplies(client, chat, roomId, event, text, maxChars) {
    const parts = splitMessage(forSpeech(text), maxChars, weightedLength);
    const synth = (part) => chat.speak(part).then(toVoiceMessage);
    let next = parts.length ? synth(parts[0]) : null;
    for (const [i, part] of parts.entries()) {
        await client.setTyping(roomId, true, 60000).catch(() => {});
        const voice = await next;
        next = i + 1 < parts.length ? synth(parts[i + 1]) : null;
        next?.catch(() => {}); // a failure is reported when that part is awaited
        await sendVoiceMessage(client, roomId, event, part, voice);
    }
}

// Sends one voice message, with its text as a caption so it is still readable.
async function sendVoiceMessage(client, roomId, event, text, voice) {
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
        "m.relates_to": replyRelation(event),
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

// Exported for tests; the bot only starts when this file is run directly.
export { handleMessage, handleUndecryptable };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error("Fatal:", err?.message || err);
        process.exit(1);
    });
}
