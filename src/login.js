// One-off helper: logs in with MATRIX_USERNAME / MATRIX_PASSWORD and prints an
// access token you can paste into MATRIX_ACCESS_TOKEN. Run with: npm run login
//
// Using a long-lived access token (instead of logging in on every start) keeps
// the bot's device — and therefore its end-to-end-encryption identity — stable.

import { MatrixAuth } from "matrix-bot-sdk";

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
const username = process.env.MATRIX_USERNAME;
const password = process.env.MATRIX_PASSWORD;
const deviceName = process.env.MATRIX_DEVICE_NAME || "melong-bot";

if (!homeserverUrl || !username || !password) {
    console.error("Set MATRIX_HOMESERVER_URL, MATRIX_USERNAME and MATRIX_PASSWORD (e.g. in .env) first.");
    process.exit(1);
}

const auth = new MatrixAuth(homeserverUrl);
const client = await auth.passwordLogin(username, password, deviceName);
const userId = await client.getUserId();
let deviceId;
try {
    deviceId = (await client.getWhoAmI())?.device_id;
} catch {}

console.log("\nLogin successful!\n");
console.log(`  User ID:      ${userId}`);
if (deviceId) console.log(`  Device ID:    ${deviceId}`);
console.log(`  Access token: ${client.accessToken}\n`);
console.log("Add this to your .env:\n");
console.log(`MATRIX_ACCESS_TOKEN=${client.accessToken}\n`);
