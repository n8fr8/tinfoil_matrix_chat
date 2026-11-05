// Sends one test message through Tinfoil to confirm the setup works.
//
//   npm run probe                       # default sample
//   npm run probe "Tell me about Mars"  # custom message

import { loadChatConfig } from "./config.js";
import { ChatClient } from "./melong.js";

if (!process.env.TINFOIL_API_KEY) {
    console.error("TINFOIL_API_KEY is not set (check your .env).");
    process.exit(1);
}

const config = loadChatConfig();
const sample = process.argv[2] || "Hi! In two sentences, what's an interesting fact about octopuses?";
console.log(`Model:   ${config.model}`);
console.log(`Message: ${JSON.stringify(sample)}\n`);

try {
    const { text } = await new ChatClient(config).chat("probe", sample);
    console.log(`✓ OK ->\n${text}`);
} catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
}
