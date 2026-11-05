// Diagnoses which wire protocol your Melong HF Inference Endpoint speaks.
// Tries each supported apiMode and reports the route, status, and parsed output.
//
//   npm run probe              # uses the prompt template with a default sample
//   npm run probe "Good night" # probe with custom text

import { loadMelongConfig } from "./config.js";
import { MelongClient, API_MODES } from "./melong.js";

const base = loadMelongConfig();
if (!base.endpointUrl) {
    console.error("MELONG_ENDPOINT_URL is not set (check your .env).");
    process.exit(1);
}

const sample = process.argv[2] || "Hello, how are you?";
console.log(`Endpoint: ${base.endpointUrl}`);
console.log(`Token:    ${base.token ? "(set)" : "(none)"}`);
console.log(`Sample:   ${JSON.stringify(sample)}\n`);

let winner = null;
for (const mode of API_MODES) {
    const client = new MelongClient({ ...base, apiMode: mode, timeoutMs: 30000 });
    const { url } = client.buildRequest(sample);
    process.stdout.write(`[${mode.padEnd(6)}] POST ${url}\n`);
    try {
        const out = await client.translate(sample);
        console.log(`          ✓ OK -> ${JSON.stringify(out)}\n`);
        winner ??= mode;
    } catch (err) {
        console.log(`          ✗ ${err.message}\n`);
    }
}

if (winner) {
    console.log(`Working mode: "${winner}". Set this in your .env:\n\n    MELONG_API_MODE=${winner}\n`);
} else {
    console.log(
        "No mode succeeded. Double-check MELONG_ENDPOINT_URL (it should be the endpoint's\n" +
        "inference base URL) and MELONG_API_TOKEN, and that the endpoint is running (not\n" +
        "scaled to zero / still initializing).",
    );
    process.exit(1);
}
