// One-off: gives the bot account a cross-signing identity whose private keys
// the bot holds, so it can sign each new device at startup (see
// src/cross-signing.js). Run with: npm run cross-signing
//
// - Uses MATRIX_CROSS_SIGNING_KEY from .env if set, otherwise makes new keys
//   and saves them there. The key is never printed.
// - Replaces any cross-signing identity the account already has (e.g. one made
//   by logging in to the bot account with Element). People who chat with the
//   bot may see a one-time "identity changed" notice.
// - Store the same value as the MATRIX_CROSS_SIGNING_KEY secret for the
//   container: tinfoil secret create MATRIX_CROSS_SIGNING_KEY --value-file -

import { MatrixAuth } from "matrix-bot-sdk";
import { promises as fs } from "node:fs";
import { crossSigningUploadBody, generateCrossSigningKeys, parseCrossSigningKey } from "./cross-signing.js";

const ENV_FILE = ".env";
const { MATRIX_HOMESERVER_URL: homeserverUrl, MATRIX_USERNAME: username, MATRIX_PASSWORD: password } = process.env;
if (!homeserverUrl || !username || !password) {
    console.error("Set MATRIX_HOMESERVER_URL, MATRIX_USERNAME and MATRIX_PASSWORD (e.g. in .env) first.");
    process.exit(1);
}

let keys;
if (process.env.MATRIX_CROSS_SIGNING_KEY) {
    keys = parseCrossSigningKey(process.env.MATRIX_CROSS_SIGNING_KEY);
    console.log("Using MATRIX_CROSS_SIGNING_KEY from the environment.");
} else {
    const generated = generateCrossSigningKeys();
    keys = generated.keys;
    await saveToEnvFile(generated.secret);
    console.log(`Generated new cross-signing keys and saved them to ${ENV_FILE} as MATRIX_CROSS_SIGNING_KEY.`);
}

// A short-lived session just for this; logged out at the end.
const client = await new MatrixAuth(homeserverUrl).passwordLogin(username, password, "melong-setup");
try {
    const userId = await client.getUserId();
    const query = await client.doRequest("POST", "/_matrix/client/v3/keys/query", null, { device_keys: { [userId]: [] } });
    const current = Object.keys(query?.master_keys?.[userId]?.keys || {});
    if (current.includes(keys.master.keyId)) {
        console.log(`${userId} already uses these cross-signing keys. Nothing to do.`);
    } else {
        if (current.length) console.log(`Replacing ${userId}'s existing cross-signing identity.`);
        const body = crossSigningUploadBody(userId, keys);
        const upload = (auth) =>
            client.doRequest("POST", "/_matrix/client/v3/keys/device_signing/upload", null, auth ? { ...body, auth } : body);
        try {
            await upload();
        } catch (err) {
            // Replacing keys needs the password (user-interactive auth).
            const session = err?.body?.session;
            if (err?.statusCode !== 401 || !session) throw err;
            await upload({ type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password, session });
        }
        console.log(`Uploaded cross-signing keys for ${userId} (master ${keys.master.publicKey}).`);
    }
    console.log("\nNext: store MATRIX_CROSS_SIGNING_KEY as a container secret and restart the bot. It signs its own device at startup.");
} finally {
    await client.doRequest("POST", "/_matrix/client/v3/logout").catch(() => {});
}

async function saveToEnvFile(secret) {
    let text = "";
    try {
        text = await fs.readFile(ENV_FILE, "utf8");
    } catch {}
    const line = `MATRIX_CROSS_SIGNING_KEY=${secret}`;
    text = /^MATRIX_CROSS_SIGNING_KEY=.*$/m.test(text)
        ? text.replace(/^MATRIX_CROSS_SIGNING_KEY=.*$/m, line)
        : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    await fs.writeFile(ENV_FILE, text, { mode: 0o600 });
}
