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
- Understands attachments: images, documents (PDF, Word, PowerPoint, Excel, CSV, text), audio and voice messages, and the soundtrack of videos. See [Attachments](#attachments).
- Replies with a voice message when asked ("answer with a voice message", "say it out loud"). See [Voice replies](#voice-replies).
- Remembers the last few exchanges per room (in memory; cleared on restart or with `!reset`).

## Requirements

- Node.js ≥ 20.11 (uses the built-in `fetch` and `--env-file`).
- A Tinfoil API key (`TINFOIL_API_KEY`).
- `ffmpeg` on the PATH, for voice messages and audio/video in formats other than MP3/WAV.
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
| `TINFOIL_TRANSCRIPTION_MODEL` | `voxtral-small-24b` | Speech-to-text model for audio and video. |
| `CHAT_MAX_ATTACHMENT_MB` | `25` | Larger attachments are refused. |
| `TINFOIL_TTS_MODEL` | `voxtral-tts` | Text-to-speech model for voice replies (`qwen3-tts` is the lower-latency alternative). |
| `TINFOIL_TTS_VOICE` | `neutral_female` | Voice name; must be one the TTS model offers (see `.env.example`). |

### Attachments

| You send | What happens |
| --- | --- |
| Image | Sent to the model (`gemma4-31b` can see images). |
| Document (PDF, DOCX, PPTX, XLSX, CSV, text…) | Sent to Tinfoil, which converts it inside the enclave and passes it to the model. |
| Audio / voice message | Transcribed with the speech-to-text model; the transcript goes to the model. |
| Video | Its audio track is transcribed (frames are not analysed). |

**Prompts:** any text sent with the attachment (its caption) is used as the instruction, e.g. an image captioned "translate the sign". With no text, the bot acts straight away: it describes images, summarises documents and videos, and replies to voice messages. Multi-image "gallery" messages are handled as one request. Placeholder texts some apps send with media (e.g. "Sent 1 media items.") are ignored. With `MATRIX_COMMAND_PREFIX` set, the caption must start with the prefix.

Files are downloaded (and decrypted in encrypted rooms) by the bot, then sent to Tinfoil. Only a short note like "[Shared an image: photo.jpg]" is kept in conversation memory, so follow-up questions work from the model's earlier answer rather than re-sending the file. Audio transcripts are kept in full.

### Voice replies

Ask for a spoken answer in your own words, by text or in a voice message ("reply with a voice message", "read this aloud"). The model flags the request, writes its answer as plain spoken text, and the bot speaks it with Tinfoil text-to-speech. The answer arrives as a Matrix voice message (Ogg/Opus with a waveform), with the text as its caption. It is encrypted in encrypted rooms. If speech synthesis fails, the bot replies in text instead. Needs `ffmpeg`.

### Testing the connection

`npm run probe` sends one test message through Tinfoil and prints the reply (`npm run probe "Tell me about Mars"` for a custom message).

## Project layout

```
src/
  index.js   bot entry point: auth, client, event handlers
  config.js  env loading + validation
  auth.js    token resolution (env / cache / password login)
  melong.js  chat client with per-room memory (Tinfoil SDK)
  media.js   attachment download/decrypt + ffmpeg audio conversion
  format.js  Markdown -> Matrix HTML for replies
  login.js   one-off: print an access token
```

## Notes

- Encryption uses `RustSdkCryptoStorageProvider` (native module bundled with `matrix-bot-sdk`). The crypto store lives in `data/crypto` — don't delete it or the bot loses its E2EE identity.
- The `util._extend` deprecation warning on startup comes from a transitive dependency of `matrix-bot-sdk`, not this project.
```
