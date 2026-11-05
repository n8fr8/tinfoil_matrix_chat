# Melong Matrix Bot

A [Matrix](https://matrix.org) chat bot, built on [`matrix-bot-sdk`](https://turt2live.github.io/matrix-bot-sdk/), that answers questions and chats about any topic using [Tinfoil](https://tinfoil.sh) private inference (default model `gemma4-31b`). Tinfoil runs models inside secure hardware enclaves, and its SDK verifies enclave attestation on every connection.

Send the bot a message and it replies. It remembers recent messages in each room, so you can have a back-and-forth conversation. Send `!reset` to make it forget the room's history.

## Features

- Private, verifiable inference via the [`tinfoil`](https://docs.tinfoil.sh/sdk/javascript-sdk) SDK — no Python, no local model.
- End-to-end encryption support (works in encrypted rooms) via the Rust crypto store.
- Flexible auth: a long-lived access token **or** username/password login (token is cached so the E2EE device stays stable).
- Auto-joins rooms when invited.
- Reply to every message, or only `!ai …`-prefixed commands.
- Replies are rendered as rich text (bold, lists, code blocks, tables) in Matrix clients.
- Remembers the last few exchanges per room (in memory; cleared on restart or with `!reset`).

## Requirements

- Node.js ≥ 20.11 (uses the built-in `fetch` and `--env-file`).
- A Tinfoil API key (`TINFOIL_API_KEY`).
- A Matrix account for the bot.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum: MATRIX_HOMESERVER_URL, an auth method, TINFOIL_API_KEY
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

Then invite the bot to a room (it auto-joins) and send a message. With `MATRIX_COMMAND_PREFIX` empty it replies to everything; set it to e.g. `!ai` to only respond to `!ai <message>` (recommended for busy group rooms).

## Configuration

All settings come from environment variables (loaded from `.env`). See [`.env.example`](.env.example) for the full list. Key ones:

| Variable | Default | Description |
| --- | --- | --- |
| `MATRIX_HOMESERVER_URL` | — | Homeserver client API URL, e.g. `https://matrix.org`. |
| `MATRIX_ACCESS_TOKEN` | — | Access token (or use username/password). |
| `MATRIX_USERNAME` / `MATRIX_PASSWORD` | — | Used for login if no token. |
| `MATRIX_ENCRYPTION` | `true` | Enable E2EE (Rust crypto store). |
| `MATRIX_AUTOJOIN` | `true` | Auto-join on invite. |
| `MATRIX_COMMAND_PREFIX` | _(empty)_ | If set, only reply to messages starting with this. |
| `TINFOIL_API_KEY` | — | Tinfoil API key (read by the SDK automatically). |
| `TINFOIL_MODEL` | `gemma4-31b` | Model ID from the [Tinfoil catalog](https://docs.tinfoil.sh/models/overview). |
| `CHAT_SYSTEM_PROMPT` | _friendly general assistant_ | The bot's personality / instructions. |
| `CHAT_HISTORY_TURNS` | `10` | Past exchanges remembered per room (`0` = none). |
| `CHAT_MAX_NEW_TOKENS` | `2048` | Reply length cap (includes reasoning tokens). |
| `CHAT_TIMEOUT_MS` | `120000` | Request timeout. |

### Testing the connection

`npm run probe` sends one test message through Tinfoil and prints the reply (`npm run probe "Tell me about Mars"` for a custom message).

## Project layout

```
src/
  index.js   bot entry point: auth, client, event handlers
  config.js  env loading + validation
  auth.js    token resolution (env / cache / password login)
  melong.js  chat client with per-room memory (Tinfoil SDK)
  login.js   one-off: print an access token
```

## Notes

- Encryption uses `RustSdkCryptoStorageProvider` (native module bundled with `matrix-bot-sdk`). The crypto store lives in `data/crypto` — don't delete it or the bot loses its E2EE identity.
- The `util._extend` deprecation warning on startup comes from a transitive dependency of `matrix-bot-sdk`, not this project.
```
