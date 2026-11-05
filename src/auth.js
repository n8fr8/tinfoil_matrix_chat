// Resolves an access token for the bot, supporting either a pre-supplied token
// or password login. The result is cached on disk so that password login only
// happens once: logging in repeatedly would create a new device each time,
// which breaks end-to-end encryption (each device has its own crypto identity).

import { MatrixAuth } from "matrix-bot-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";

async function readCache(cachePath) {
    try {
        return JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch {
        return null;
    }
}

async function writeCache(cachePath, creds) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * @returns {Promise<{accessToken: string, userId?: string, deviceId?: string, source: string}>}
 */
export async function resolveCredentials(config) {
    // 1. Explicit access token from the environment wins.
    if (config.accessToken) {
        return { accessToken: config.accessToken, source: "env" };
    }

    // 2. Reuse a cached token from a previous password login (stable device).
    const cached = await readCache(config.credentialsPath);
    if (
        cached?.accessToken &&
        cached.homeserverUrl === config.homeserverUrl &&
        cached.username === config.username
    ) {
        return { ...cached, source: "cache" };
    }

    // 3. Fresh password login.
    if (!config.username || !config.password) {
        throw new Error(
            "No access token available. Set MATRIX_ACCESS_TOKEN, or MATRIX_USERNAME + MATRIX_PASSWORD.",
        );
    }

    const auth = new MatrixAuth(config.homeserverUrl);
    const loginClient = await auth.passwordLogin(config.username, config.password, config.deviceName);
    const userId = await loginClient.getUserId();
    let deviceId;
    try {
        deviceId = (await loginClient.getWhoAmI())?.device_id;
    } catch {
        // Non-fatal: deviceId is informational here.
    }

    const creds = {
        homeserverUrl: config.homeserverUrl,
        username: config.username,
        accessToken: loginClient.accessToken,
        userId,
        deviceId,
    };
    await writeCache(config.credentialsPath, creds);
    return { ...creds, source: "login" };
}
