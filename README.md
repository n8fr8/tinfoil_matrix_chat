# Melong Matrix Bot

A [Matrix](https://matrix.org) chat bot, built on [`matrix-bot-sdk`](https://turt2live.github.io/matrix-bot-sdk/), that translates messages into Tibetan using the **Melong** (`TenzinGayche/Melong_preview`) model served from a Hugging Face Inference Endpoint over HTTP.

Send the bot a message and it replies with the Tibetan translation.

## Features

- Talks to a Hugging Face Inference Endpoint over plain HTTP (`fetch`) — no Python, no local model.
- End-to-end encryption support (works in encrypted rooms) via the Rust crypto store.
- Flexible auth: a long-lived access token **or** username/password login (token is cached so the E2EE device stays stable).
- Auto-joins rooms when invited.
- Translate every message, or only `!tr …`-prefixed commands.

## Requirements

- Node.js ≥ 20.11 (uses the built-in `fetch` and `--env-file`).
- A Hugging Face Inference Endpoint serving `TenzinGayche/Melong_preview`, plus an HF token.
- A Matrix account for the bot.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum: MATRIX_HOMESERVER_URL, an auth method, MELONG_ENDPOINT_URL
```

### Authentication

**Option A — access token (recommended).** Put a token in `MATRIX_ACCESS_TOKEN`. To mint one from a username/password:

```bash
npm run login   # prints an access token to paste into .env
```

**Option B — password login.** Leave `MATRIX_ACCESS_TOKEN` empty and set `MATRIX_USERNAME` + `MATRIX_PASSWORD`. The bot logs in once and caches the token in `data/credentials.json` so it reuses the same device on restart (important for encryption).

## Run

```bash
npm start
```

Then invite the bot to a room (it auto-joins) and send a message. With `MATRIX_COMMAND_PREFIX` empty it translates everything; set it to e.g. `!tr` to only respond to `!tr <text>`.

## Configuration

All settings come from environment variables (loaded from `.env`). See [`.env.example`](.env.example) for the full list. Key ones:

| Variable | Default | Description |
| --- | --- | --- |
| `MATRIX_HOMESERVER_URL` | — | Homeserver client API URL, e.g. `https://matrix.org`. |
| `MATRIX_ACCESS_TOKEN` | — | Access token (or use username/password). |
| `MATRIX_USERNAME` / `MATRIX_PASSWORD` | — | Used for login if no token. |
| `MATRIX_ENCRYPTION` | `true` | Enable E2EE (Rust crypto store). |
| `MATRIX_AUTOJOIN` | `true` | Auto-join on invite. |
| `MATRIX_COMMAND_PREFIX` | _(empty)_ | If set, only translate messages starting with this. |
| `MELONG_ENDPOINT_URL` | — | Your HF Inference Endpoint URL. |
| `MELONG_API_TOKEN` / `HF_TOKEN` | — | HF token for the endpoint. |
| `MELONG_PROMPT_TEMPLATE` | _translate prompt_ | `{text}` is replaced with the message. |
| `MELONG_INPUT_MODE` | `messages` | `messages` (chat array) or `text` (raw string). |
| `MELONG_MAX_NEW_TOKENS` | `256` | Generation length cap. |

### Endpoint wire format

By default the bot POSTs `{"inputs": [{"role":"user","content": "<prompt>"}], "parameters": {"max_new_tokens": N}}`, matching the model card's `pipeline("text-generation", …)` usage, and reads the assistant turn out of the response. It also parses TGI string output (`[{"generated_text": "…"}]`) and OpenAI-compatible responses (`{choices:[{message:{content}}]}`), so it works against most endpoint deployments. If your endpoint expects a raw string instead of a chat array, set `MELONG_INPUT_MODE=text`.

## Project layout

```
src/
  index.js   bot entry point: auth, client, event handlers
  config.js  env loading + validation
  auth.js    token resolution (env / cache / password login)
  melong.js  HTTP client for the Melong HF endpoint
  login.js   one-off: print an access token
```

## Notes

- Encryption uses `RustSdkCryptoStorageProvider` (native module bundled with `matrix-bot-sdk`). The crypto store lives in `data/crypto` — don't delete it or the bot loses its E2EE identity.
- A scale-to-zero HF endpoint may return `503` while warming up; the bot reports this and you can retry.
- The `util._extend` deprecation warning on startup comes from a transitive dependency of `matrix-bot-sdk`, not this project.
```
