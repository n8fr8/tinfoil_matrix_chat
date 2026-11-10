// Cross-signing for the bot's own devices.
//
// The container has no persistent storage, so every start is a new Matrix
// device with new encryption keys. Current Element clients only send room keys
// to devices that their owner has cross-signed, so an unsigned bot device can't
// read new messages. The bot keeps a stable cross-signing identity instead: its
// private keys live in the MATRIX_CROSS_SIGNING_KEY secret (made once with
// `npm run cross-signing`), and each new device signs itself at startup.

import crypto from "node:crypto";
import { LogService } from "matrix-bot-sdk";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ROLES = ["master", "self_signing", "user_signing"];

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");

// Matrix canonical JSON: sorted keys, no whitespace, UTF-8.
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

class SigningKey {
    constructor(seed) {
        this.seed = Buffer.from(seed);
        this.privateKey = crypto.createPrivateKey({
            key: Buffer.concat([PKCS8_ED25519_PREFIX, this.seed]),
            format: "der",
            type: "pkcs8",
        });
        this.publicKey = b64(crypto.createPublicKey(this.privateKey).export({ format: "der", type: "spki" }).subarray(12));
        this.keyId = `ed25519:${this.publicKey}`;
    }

    // Returns a copy of `obj` with this key's signature added (signatures and
    // `unsigned` are excluded from what is signed, as the spec requires).
    sign(userId, obj) {
        const { signatures = {}, unsigned, ...rest } = obj;
        const sig = b64(crypto.sign(null, Buffer.from(canonicalJson(rest), "utf8"), this.privateKey));
        return { ...rest, signatures: { ...signatures, [userId]: { ...(signatures[userId] || {}), [this.keyId]: sig } } };
    }
}

/** New random keys, as the single-line secret value plus the parsed keys. */
export function generateCrossSigningKeys() {
    const seeds = Object.fromEntries(ROLES.map((r) => [r, b64(crypto.randomBytes(32))]));
    const secret = Buffer.from(JSON.stringify(seeds)).toString("base64");
    return { secret, keys: parseCrossSigningKey(secret) };
}

/** Parses MATRIX_CROSS_SIGNING_KEY into {master, self_signing, user_signing} SigningKeys. */
export function parseCrossSigningKey(secret) {
    let seeds;
    try {
        seeds = JSON.parse(Buffer.from(secret.trim(), "base64").toString("utf8"));
    } catch {
        throw new Error("MATRIX_CROSS_SIGNING_KEY is not valid (expected the value written by `npm run cross-signing`)");
    }
    return Object.fromEntries(
        ROLES.map((r) => {
            const seed = Buffer.from(seeds?.[r] || "", "base64");
            if (seed.length !== 32) throw new Error(`MATRIX_CROSS_SIGNING_KEY is missing a valid ${r} key`);
            return [r, new SigningKey(seed)];
        }),
    );
}

/** The device_signing/upload body (without auth) for these keys. */
export function crossSigningUploadBody(userId, keys) {
    const keyObj = (role) => ({ user_id: userId, usage: [role], keys: { [keys[role].keyId]: keys[role].publicKey } });
    return {
        master_key: keyObj("master"),
        self_signing_key: keys.master.sign(userId, keyObj("self_signing")),
        user_signing_key: keys.master.sign(userId, keyObj("user_signing")),
    };
}

/**
 * Signs this device with the bot's self-signing key, so other users' clients
 * trust it. Never throws; returns a short status string for logs.
 * @param {import("matrix-bot-sdk").MatrixClient} client
 */
export async function signOwnDevice(client, keys, { attempts = 5, delayMs = 3000 } = {}) {
    try {
        const { user_id: userId, device_id: deviceId } = await client.getWhoAmI();
        for (let attempt = 1; ; attempt++) {
            const res = await client.doRequest("POST", "/_matrix/client/v3/keys/query", null, {
                device_keys: { [userId]: [deviceId] },
            });
            const published = Object.keys(res?.self_signing_keys?.[userId]?.keys || {});
            if (!published.includes(keys.self_signing.keyId)) {
                const msg = published.length
                    ? "the account's cross-signing keys don't match MATRIX_CROSS_SIGNING_KEY (were they reset from another client?); run `npm run cross-signing` again"
                    : "the account has no cross-signing keys; run `npm run cross-signing`";
                LogService.warn("melong", `Not cross-signing this device: ${msg}`);
                return "mismatch";
            }
            const device = res?.device_keys?.[userId]?.[deviceId];
            if (!device) {
                // The crypto engine uploads the device keys during startup; wait for them.
                if (attempt >= attempts) throw new Error(`device ${deviceId} has no published keys`);
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }
            if (device.signatures?.[userId]?.[keys.self_signing.keyId]) return "already signed";
            const out = await client.doRequest("POST", "/_matrix/client/v3/keys/signatures/upload", null, {
                [userId]: { [deviceId]: keys.self_signing.sign(userId, device) },
            });
            const failure = out?.failures?.[userId]?.[deviceId];
            if (failure) throw new Error(failure.message || JSON.stringify(failure));
            LogService.info("melong", `Cross-signed this device (${deviceId}) with the bot's identity`);
            return "signed";
        }
    } catch (err) {
        LogService.warn("melong", `Could not cross-sign this device: ${err?.body?.error || err?.message || err}`);
        return "failed";
    }
}
