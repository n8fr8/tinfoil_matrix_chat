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

async function main() {
    const config = loadConfig();

    LogService.setLogger(new RichConsoleLogger());
    LogService.setLevel(LogLevel.fromString(config.logLevel));
    LogService.muteModule("Metrics");

    // Make sure storage directories exist before the providers touch them.
    await fs.mkdir(path.dirname(config.storagePath), { recursive: true });

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
    if (config.autojoin) setupAutojoin(client);

    const chat = new ChatClient(config.chat);

    // Cache our own user id so we can ignore our own messages without an await per event.
    const botUserId = await client.getUserId();

    client.on("room.message", (roomId, event) => {
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

async function handleMessage(client, chat, config, botUserId, roomId, event) {
    const content = event?.content;
    if (!content || content.msgtype !== "m.text") return; // only plain text
    if (event.sender === botUserId) return; // ignore our own messages

    let body = (content.body || "").trim();
    if (!body) return;

    // Optional command prefix: only react to "!ai ..." style messages when set.
    if (config.commandPrefix) {
        if (!body.startsWith(config.commandPrefix)) return;
        body = body.slice(config.commandPrefix.length).trim();
        if (!body) {
            await client.replyNotice(roomId, event, `Usage: ${config.commandPrefix} <your message>`);
            return;
        }
    }

    // "!reset" clears the bot's memory of this room.
    if (body === "!reset") {
        chat.reset(roomId);
        await client.replyNotice(roomId, event, "Conversation history cleared.");
        return;
    }

    await client.setTyping(roomId, true, 30000).catch(() => {});
    try {
        const reply = await chat.chat(roomId, body);
        // Plain Markdown stays in `body` as a fallback; clients render the HTML.
        await client.sendMessage(roomId, RichReply.createFor(roomId, event, reply, markdownToMatrixHtml(reply)));
    } catch (err) {
        LogService.error("melong", "Chat request failed:", err?.message || err);
        await client.replyNotice(roomId, event, `Sorry, something went wrong: ${err?.message || err}`);
    } finally {
        await client.setTyping(roomId, false).catch(() => {});
    }
}

main().catch((err) => {
    console.error("Fatal:", err?.message || err);
    process.exit(1);
});
