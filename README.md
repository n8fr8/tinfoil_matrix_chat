# Tinfoil Matrix Bot

A [Matrix](https://matrix.org) chat bot, built on [`matrix-bot-sdk`](https://turt2live.github.io/matrix-bot-sdk/), that answers questions and chats about any topic using [Tinfoil](https://tinfoil.sh) private inference (default model `deepseek-v4-1-flash`). Tinfoil runs models inside secure hardware enclaves, and its SDK verifies enclave attestation on every connection.

Send the bot a message and it replies. It remembers recent messages in each room, so you can have a back-and-forth conversation. Send `!reset` to make it forget the room's history.

## Features

- Private, verifiable inference via the [`tinfoil`](https://docs.tinfoil.sh/sdk/javascript-sdk) SDK — no Python, no local model.
- End-to-end encryption support (works in encrypted rooms) via the Rust crypto store.
- Flexible auth: a long-lived access token **or** username/password login (token is cached so the E2EE device stays stable).
- Auto-joins rooms when invited.
- Reply to every message, or only `!ai …`-prefixed commands.
- Replies are rendered as rich text (bold, lists, code blocks, tables) in Matrix clients.
- Understands attachments: images, documents (PDF, Word, PowerPoint, Excel, CSV, text), audio and voice messages, and the soundtrack of videos. See [Attachments](#attachments).
- Answers voice messages with a voice message (plus the text), and replies by voice when asked ("answer with a voice message", "say it out loud"). See [Voice replies](#voice-replies).
- Searches the web when a question needs current information, and cites its sources (Tinfoil web search; `WEB_SEARCH=false` turns it off). See [Web search](#web-search).
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
| `MATRIX_DISPLAY_NAME` | _(unchanged)_ | Bot's display name in rooms; applied on startup. |
| `MATRIX_CLEANUP_OLD_DEVICES` | `false` | After a password login, delete this account's other devices named `MATRIX_DEVICE_NAME`. |
| `HEALTH_PORT` | _(off)_ | Serve a JSON status endpoint on this port (`8080` in the container). |
| `MATRIX_ENCRYPTION` | `true` | Enable E2EE (Rust crypto store). |
| `MATRIX_CROSS_SIGNING_KEY` | — | The bot's private cross-signing keys, made by `npm run cross-signing`. The bot signs each new device with them. Needed when storage doesn't survive restarts (containers). See [How storage works](#how-storage-works-in-the-container). |
| `MATRIX_AUTOJOIN` | `true` | Auto-join on invite. |
| `MATRIX_COMMAND_PREFIX` | _(empty)_ | If set, only reply to messages starting with this. |
| `TINFOIL_API_KEY` | — | Tinfoil API key (read by the SDK automatically). |
| `TINFOIL_MODEL` | `deepseek-v4-1-flash` | Model ID from the [Tinfoil catalog](https://docs.tinfoil.sh/models/overview). `deepseek-v4-1-flash` is fast and writes clean Tibetan; `kimi-k3` also writes clean Tibetan but is 5–10x slower; `gemma4-31b` mixes other scripts into Tibetan replies. See [docs/tibetan-speech-models.md](docs/tibetan-speech-models.md#reply-model-llm). |
| `CHAT_SYSTEM_PROMPT` | _friendly general assistant_ | The bot's personality / instructions. |
| `CHAT_HISTORY_TURNS` | `10` | Past exchanges remembered per room (`0` = none). |
| `CHAT_MAX_NEW_TOKENS` | `16000` | Reply length cap, including the model's reasoning ("thinking") tokens. |
| `CHAT_TIMEOUT_MS` | `300000` | Request timeout (thinking models can take a minute or more). |
| `WEB_SEARCH` | `true` | Let the model search the web when it needs to. See [Web search](#web-search). |
| `TINFOIL_TRANSCRIPTION_MODEL` | `voxtral-small-24b` | Speech-to-text model for audio and video. |
| `CHAT_MAX_ATTACHMENT_MB` | `25` | Larger attachments are refused. |
| `TINFOIL_TTS_MODEL` | `voxtral-tts` | Text-to-speech model for voice replies (`qwen3-tts` is the lower-latency alternative). |
| `TINFOIL_TTS_VOICE` | `neutral_female` | Voice name; must be one the TTS model offers (see `.env.example`). |

### Web search

With `WEB_SEARCH=true` (the default) the bot asks for [Tinfoil web search](https://docs.tinfoil.sh/guides/web-search) on every message. The model decides whether to search: small talk is answered directly (about 4 s), and questions about current events search first (about 10 s). Sources appear as links in the text reply. Voice replies leave the links out.

- Searches run inside Tinfoil's enclave, which queries [Exa](https://exa.ai) under a zero-data-retention agreement. Exa sees the enclave's address, not the bot's.
- The bot turns on both of Tinfoil's filters: personal data (emails, phone numbers, account numbers, secrets) is masked from search queries, and results that try to inject instructions are dropped. The masking is model-based, so it can miss things.
- Tinfoil charges a web search fee once per request that actually searches.

### Attachments

| You send | What happens |
| --- | --- |
| Image | Sent to the model (`deepseek-v4-1-flash`, `kimi-k3` and `gemma4-31b` can see images). |
| Document (PDF, DOCX, PPTX, XLSX, CSV, text…) | Sent to Tinfoil, which converts it inside the enclave and passes it to the model. |
| Audio / voice message | Transcribed with the speech-to-text model; the transcript goes to the model. |
| Video | Its audio track is transcribed (frames are not analysed). |

**Prompts:** any text sent with the attachment (its caption) is used as the instruction, e.g. an image captioned "translate the sign". With no text, the bot acts straight away: it describes images, summarises documents and videos, and replies to voice messages. Multi-image "gallery" messages are handled as one request. Placeholder texts some apps send with media (e.g. "Sent 1 media items.") are ignored. With `MATRIX_COMMAND_PREFIX` set, the caption must start with the prefix.

Files are downloaded (and decrypted in encrypted rooms) by the bot, then sent to Tinfoil. Only a short note like "[Shared an image: photo.jpg]" is kept in conversation memory, so follow-up questions work from the model's earlier answer rather than re-sending the file. Audio transcripts are kept in full.

### Voice replies

A voice message (or any audio) always gets a spoken answer, in the language spoken. In text, ask for one in your own words ("reply with a voice message", "read this aloud"); the model flags the request. Either way the model writes its answer as plain spoken text, and the bot sends it twice: first as a normal text message, then as a Matrix voice message (Ogg/Opus with a waveform) spoken with text-to-speech. Both are encrypted in encrypted rooms. If speech synthesis fails, the text reply is followed by a short note saying so. Needs `ffmpeg`.

### Tibetan speech (optional sidecar)

Tinfoil's hosted speech models don't handle Tibetan, so `speech/` is a small CPU-only service running two open Tibetan models, deployed as a second container in the same enclave. [docs/tibetan-speech-models.md](docs/tibetan-speech-models.md) explains how they were chosen.

- **Text-to-speech:** `facebook/mms-tts-bod`. Tibetan-script parts of a voice reply are spoken with it and everything else with `TINFOIL_TTS_MODEL`; a mixed reply (say, Tibetan with an English gloss) becomes one voice message stitched from both.
- **Speech-to-text:** `ganga4364/wav2vec2-combine-dialect-model-v2-47000`, a Tibetan wav2vec2 model from an OpenPecha developer, trained on several dialects. It's exported to ONNX and quantized to int8 at build time. On real Tibetan recordings its character error rate was 26%, against 60% for Meta's `facebook/mms-1b-all`, which it replaced. By default (`SPEECH_STT=auto`) each voice note goes to both this model and Tinfoil's Whisper (`SPEECH_DETECT_MODEL`, default `whisper-large-v3-turbo`) in parallel. Whisper can't transcribe Tibetan: on Tibetan speech it returns nothing or low-confidence gibberish. So when Whisper is confident (mean log-probability above `SPEECH_DETECT_THRESHOLD`, default `-0.45`), its transcript is used; otherwise the Tibetan one is. On 59 real clips (Tibetan, English, French, Hindi, Mandarin, Nepali) this routed 58 correctly; the miss was a Nepali clip. `SPEECH_STT=tibetan` uses only this model, and `SPEECH_STT=general` only `TINFOIL_TRANSCRIPTION_MODEL`.

Both models are exported to ONNX at image build time (`speech/build_models.py`, which also self-tests the conversion), so the running image needs only ONNX Runtime and NumPy, not PyTorch. That matters because inside a Tinfoil enclave with less than 32 GB of memory, **all container images share a fixed 4 GB ramdisk**, counting both their compressed and unpacked size. For the same reason the bot image uses a static `ffmpeg` binary instead of Debian's package.

Set `SPEECH_URL` to enable it (`http://speech:8000` in the container). `/health` shows its state as `speechSidecar`, and `/diag?speech=1` speaks a fixed Tibetan sentence, encodes it as a voice message and transcribes it back, all inside the enclave. If the sidecar fails on Tibetan speech, the bot reports it in the chat (in `auto` mode it falls back to Whisper's low-confidence transcript when there is one).

**Licenses:** `facebook/mms-tts-bod` is **CC-BY-NC 4.0** (non-commercial use only, with attribution to Meta's MMS project). The speech-to-text model's card states **no license**, so reuse rights are unclear; ask its authors before any use beyond a prototype.

### Testing the connection

`npm run probe` sends one test message through Tinfoil and prints the reply (`npm run probe "Tell me about Mars"` for a custom message).

## Deploying as a Tinfoil Container

The bot can run inside a [Tinfoil Container](https://docs.tinfoil.sh/containers/overview), so the bot itself (including your Matrix password, decrypted messages, and attachments) runs inside a secure enclave, not just the AI inference.

What's in the repo:

- `Dockerfile`: Node 22 + ffmpeg image. Settings come from the environment; `.env` is never copied in (see `.dockerignore`).
- `tinfoil-config.yml`: the enclave config. CPUs/memory, an outbound allowlist (the homeserver plus Tinfoil's API), in-memory storage, healthcheck, and which settings/secrets the bot gets.
- `.github/workflows/tinfoil-release*.yml`: Tinfoil's standard release workflows. They build the image, pin its digest in `tinfoil-config.yml`, and publish a signed release.

### Steps

1. Push this repo to GitHub as a **public** repository (Tinfoil requires the config to be public so anyone can verify the enclave). Make sure `.env` is not committed.
2. In `tinfoil-config.yml`, replace `OWNER/REPO` in `image:` with the repo's path (e.g. `ghcr.io/my-org/melong_matrix`). If your homeserver isn't `wick.keanu.im`, change it in both `MATRIX_HOMESERVER_URL` and the `allow` list. Commit.
3. In the [Tinfoil dashboard](https://dash.tinfoil.sh) → **Secrets**, add `TINFOIL_API_KEY`, `MATRIX_PASSWORD` and `MATRIX_CROSS_SIGNING_KEY` (run `npm run cross-signing` first; it writes the value to `.env`).
4. Run the release workflow: `gh workflow run tinfoil-release.yml -f version=v0.1.0` (or **Actions → Tinfoil Release**).
5. Dashboard → **Containers → Deploy**, pick the repo and tag, and set `MATRIX_USERNAME` (plus optionally `MATRIX_DISPLAY_NAME` / `MATRIX_COMMAND_PREFIX`).
6. Check `https://<container-name>.<org>.containers.tinfoil.dev/health`; it returns `{"ok":true,...}` once the bot is syncing.

To update: commit changes, run the release workflow with a new version, then click **Update** in the dashboard.

### How storage works in the container

The container's storage is in memory and is wiped on every restart. So the container uses **password login** (not `MATRIX_ACCESS_TOKEN`): each start logs in as a new Matrix device with fresh encryption keys, and `MATRIX_CLEANUP_OLD_DEVICES=true` deletes the bot's previous devices (only ones named `MATRIX_DEVICE_NAME`). The bot also ignores messages sent before it started, so it doesn't answer old history after a restart. Conversation memory resets on restart too.

Current Element clients only share room keys with devices that their owner has cross-signed, so an unsigned new device can't read anything. To keep the bot readable across restarts, run `npm run cross-signing` once: it gives the bot account a cross-signing identity and saves the private keys to `.env` as `MATRIX_CROSS_SIGNING_KEY`. Store that as a container secret, and the bot signs each new device at startup (`/health` shows `"crossSigning": "signed"`). Running it replaces any identity the account had, so people may see a one-time "identity changed" notice for the bot. Don't log in to the bot account with Element afterwards and reset its identity there, or the key stops matching.

Consequences: after a restart the bot can't read encrypted messages sent before it came back. Tinfoil's [encrypted persistent volumes](https://docs.tinfoil.sh/containers/encrypted-volumes) (beta, needs your own keyserver) could keep state across restarts.

**Don't run the bot locally and in the container with the same account and device name at the same time.** Each start removes the other's device.

## Project layout

```
src/
  index.js   bot entry point: auth, client, event handlers
  config.js  env loading + validation
  auth.js    token resolution (env / cache / password login)
  melong.js  chat client with per-room memory (Tinfoil SDK)
  media.js   attachment download/decrypt + ffmpeg audio conversion
  format.js  Markdown -> Matrix HTML for replies
  health.js  HTTP status endpoint (for containers)
  speech.js  client for the Tibetan speech sidecar
speech/      Tibetan TTS/STT sidecar (Python, ONNX Runtime)
  login.js   one-off: print an access token
docs/        research notes (Tibetan speech model comparison)
TODO.md      follow-ups (testing, licensing, reply model)
```

## Notes

- Open follow-ups (voice-note testing, licensing, Monlam Melong) are tracked in [TODO.md](TODO.md).
- Encryption uses `RustSdkCryptoStorageProvider` (native module bundled with `matrix-bot-sdk`). The crypto store lives in `data/crypto` — don't delete it or the bot loses its E2EE identity.
- The `util._extend` deprecation warning on startup comes from a transitive dependency of `matrix-bot-sdk`, not this project.
```
