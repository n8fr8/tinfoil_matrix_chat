# CLAUDE.md

Context for working on this repo. Read it first; [README.md](README.md) is the user-facing reference for features and settings, and [TODO.md](TODO.md) has open follow-ups.

## What this is

A Matrix chatbot ("Melong") that answers in Matrix rooms using private, attested inference from [Tinfoil](https://tinfoil.sh), deployed as a Tinfoil Container (an attested enclave). It is aimed at Tibetan users: Tibetan speech-to-text and text-to-speech, Tibetan-aware replies, plus web search, topic prompts, a per-room memory (wiki), and voice replies.

- **Repo:** `n8fr8/tinfoil_matrix_chat` on GitHub. Work happens on `main`.
- **Production:** Tinfoil container `matrix-chat`, `https://matrix-chat.guardian-project.containers.tinfoil.dev`. Bot account `@melongbot:keanu.im` on homeserver `https://wick.keanu.im`.
- **Status:** a prototype with one user (the owner). Production updates and releases are fine without asking first. Still report what you deployed.

## Rules

- **Secrets:** `TINFOIL_API_KEY`, `MATRIX_PASSWORD`, `MATRIX_CROSS_SIGNING_KEY` and `WIKI_ENCRYPTION_KEY` live only in the local `.env` (gitignored) and as Tinfoil org secrets. Never hardcode, commit, print or log them. To move a value from `.env` into Tinfoil without displaying it:
  `grep '^NAME=' .env | cut -d= -f2- | tr -d '\n' | tinfoil secret create NAME --value-file -` (or `secret set` for an existing one).
- **Stage files by name** (`git add src/x.js README.md`), then check `git status --short`. Never `git add -A` or `git add .`: the owner edits `.env` in vim, and `.env.swp` (with secrets) was committed once. GitHub push protection caught it.
- **Never `pkill -f <pattern>`** in a shell command that also contains the pattern: it kills its own shell. Find the PID and `kill` it.
- **Don't run the bot locally with the production account** while production is running. Each start deletes the other's device (`MATRIX_CLEANUP_OLD_DEVICES`) and they fight over the same rooms. For local checks, see Testing.
- **Keep docs current:** update README.md (features, settings table, project layout), `.env.example`, and TODO.md with each change. End commit messages with the `Co-Authored-By` line the session gives you.

## Layout

```
src/index.js          entry: startup, Matrix client, message handling, replies, !memory commands
src/config.js         env -> config (all settings and defaults)
src/melong.js         ChatClient: system prompt, Tinfoil chat calls, tool loop, history, STT routing, TTS
src/media.js          attachment download/decrypt, ffmpeg conversion, voice message encoding, uploads
src/split.js          splits long replies into several text / voice messages
src/pdf.js            PDF documents: create_pdf tool, Markdown -> sanitized HTML -> WeasyPrint
src/forensics.js      inspect_media tool: sha256, c2patool (C2PA + trust lists), exiftool, proofmode check for zips
src/prompts.js        topic prompts: loads prompts/*.md, classifies each message
src/wiki.js           room memory: encrypted storage in Matrix, wiki tools for the model
src/wiki-schema.md    the rules the model follows for each room's wiki (copied in as SCHEMA.md)
src/cross-signing.js  signs the bot's new device at startup; cross-signing-setup.js = npm run cross-signing
src/speech.js         client for the Tibetan speech sidecar; splitByScript for mixed-script TTS
src/auth.js           password login, token cache, old-device cleanup
src/health.js         /health and /diag (?inference=1, ?speech=1) endpoints
src/format.js         Markdown -> Matrix HTML
speech/               Tibetan STT/TTS sidecar (Python, ONNX Runtime, CPU), its own container
prompts/              topic prompts (digital-security, legal, history, debate, nonviolent-action, osint); README explains the format
c2pa-trust/           C2PA trust lists (official + legacy interim), vendored so the attested image has a fixed trust store
docs/                 research notes: tibetan-speech-models.md, multi-account-spec.md (on hold)
test/                 offline tests (npm test)
tinfoil-config.yml    the measured container config (public; no secret values)
.github/workflows/    tinfoil-release.yml (build) -> tinfoil-release-publish.yml (attest, publish)
```

## How a message is handled

1. `handleMessage` (index.js) ignores the bot's own messages and anything older than startup. Media go to `handleAttachments`; text has reply quotes stripped and runs `!reset` / `!memory` commands.
2. The replied-to message (or thread root) is fetched with `quotedMessage`: its text becomes context, or its file becomes an attachment.
3. `respond` downloads attachments, then `chatWithWiki` takes the room's memory lock and calls `ChatClient.chat`.
4. `chat` (melong.js): audio is transcribed (`transcribeForModel`). The topic classifier picks a prompt. The system prompt is built (base + topic guidance + room memory instructions + voice/Tibetan rules), then the model is called with web search on and its tools (wiki, create_pdf, and inspect_media when the message has attachments). Tool rounds repeat until it answers.
5. The reply is split (`split.js`) and sent as text messages in the main timeline, followed by any PDFs the model made with `create_pdf`. For voice input, or when asked, it is also sent as voice messages (`sendVoiceReplies`). The wiki is saved if it changed.

## Behaviors that look odd but are deliberate

**Client quirks** (the owner's Matrix client; verified from event order and relations, see Testing):
- A voice note arrives as a short placeholder text ("Sent 1 media items.") plus the audio as a **thread reply** under it.
- A file with a note can arrive either way round. "Text, then the file as a thread reply on it" is common. So is "file, then the note as a thread reply".
- Handling (index.js):
  - A captionless file waits `FILE_NOTE_WAIT_MS` (6 s) for a note from the same sender (`pendingFiles`).
  - A file that arrives while its text is still being answered aborts that answer and restarts it with the file (`inflight`, `AbortController`).
  - If that answer was already sent, the file is answered using its thread-root text.
  - Placeholders are never used as prompts, and audio skips the wait.
  - Replies always go in the **main timeline**, quoting the thread root. Posting inside threads hid the answers.
  - `test/messages.test.js` encodes all of these cases.

**Encryption across restarts:** the container's disk is a wiped tmpfs, so every start is a new Matrix device. Current Element clients don't send room keys to devices their owner hasn't cross-signed. The bot holds its own cross-signing keys (`MATRIX_CROSS_SIGNING_KEY`, made by `npm run cross-signing`) and signs each new device at startup; `/health` shows `"crossSigning": "signed"`. Running the setup again resets the account's identity. Messages sent before a restart can't be decrypted.

**Room memory ("memory" to users, a wiki internally):**
- Each room's wiki is a zip, encrypted with AES-256-GCM under a per-room key derived (HKDF) from `WIKI_ENCRYPTION_KEY`. It's uploaded as homeserver media, and the bot's room account data `org.guardianproject.melong.wiki` points at the latest upload.
- Writes happen only when someone asks ("remember this", `!memory add`); otherwise the model may offer once.
- User-facing replies never mention pages or files.
- A wrong key makes the bot refuse to load the memory, rather than overwrite it.

**Media forensics (`inspect_media`, src/forensics.js):** only offered when the message has attachments, and only over those files (the history keeps text notes, not files). c2patool is run with `--settings c2pa-trust/c2pa.toml`: that file doesn't exist, but c2patool loads the trust list files next to it; without them every signer shows as untrusted. Zips aren't sent to the model as files (it can't read them); they get a text note pointing at the tool plus downscaled JPEGs (ffmpeg) of up to 4 photos/video frames from inside (`bundleImages`). Zips have their own size limit (`CHAT_MAX_ARCHIVE_MB`, 100 MB; the homeserver allows 1 GB). `unpackArchive` opens one level of nested zips and caps the expanded size at 1 GB; `proofmode check` runs on the outer zip and on each nested one. Tool output is framed as untrusted data, since metadata text comes from whoever made the file. c2patool and proofmode are built from source in a Rust stage of the Dockerfile because the c2patool release binaries need glibc 2.39 (Debian 12 has 2.36).

**Topic prompts:** one quick classifier call per message (the reply model, about 0.5 s) picks a `prompts/*.md` file using its `description`, with the previous exchange as context so follow-ups such as "I accept" keep their topic.

**Speech routing (`SPEECH_STT=auto`):**
- Each voice note goes to Whisper (`verbose_json`) and the Tibetan sidecar in parallel. Whisper's duration-weighted `avg_logprob` at or above −0.45 means "not Tibetan, use Whisper"; otherwise the Tibetan transcript is used.
- For replies, Tibetan text is spoken by the sidecar's MMS-TTS, other scripts by `voxtral-tts`. Mixed text is split by script and joined.
- `voxtral-tts` rejects input over 2000 characters (CJK counts as 3); voice parts default to 600 characters.
- Model choices and test results: `docs/tibetan-speech-models.md`.

**Reply model:** `deepseek-v4-1-flash`. It's a reasoning model: thinking counts against `max_tokens`, hence `CHAT_MAX_NEW_TOKENS=16000`. Small limits return empty content with `finish_reason: "length"`. Gemma mixed other scripts into Tibetan, and Kimi K3 was 5–10x slower.

## Release and deploy

```sh
git push                                                    # commit first (staged by name)
gh workflow run tinfoil-release.yml -f version=vX.Y.Z      # build + push image, tag, draft release
# wait for it, then for the auto-triggered "Tinfoil Release - Publish" run to un-draft the release:
until [ "$(gh release view vX.Y.Z --json isDraft -q .isDraft)" = "false" ]; do sleep 15; done
tinfoil container update matrix-chat --tag vX.Y.Z --yes --no-wait
tinfoil container get matrix-chat              # "Repo: ...@vX.Y.Z" and no "Updating to" line = done
curl -s https://matrix-chat.guardian-project.containers.tinfoil.dev/health
curl -s "https://matrix-chat.guardian-project.containers.tinfoil.dev/diag?inference=1"
```

- Versions are tagged `v0.3.N`; check `gh release list -L3` for the latest.
- Deploying before the publish run finishes fails with "Release not found".
- Updates are blue-green: the old instance keeps serving until the new one is healthy.
- **A failed update is silent:** `/health` keeps answering from the old version. Find the reason with `tinfoil container get matrix-chat -o json` -> `update_boot_stages` (e.g. `melong-bot: exit 1`). Then `tinfoil container cancel matrix-chat` before retrying, and confirm `Updating to: vX (pending)` appears.
- `/health` reports `speechSidecar: "unreachable"` for the first ~30 s after a start.
- A new secret must be listed under `secrets:` in `tinfoil-config.yml` **and** exist in Tinfoil before the release that uses it is deployed.
- An occasional `denied: write_package` on the GHCR push was transient; `gh run rerun <id> --failed` fixed it.

## Tinfoil gotchas

- **Image ramdisk:** below 32 GB of enclave memory, all container images share a 4 GB ramdisk (compressed plus unpacked). An oversized image makes an update hang at "pending" with no error. That's why the sidecar uses int8 ONNX (about 700 MB image), ffmpeg is a static binary, and WeasyPrint is installed with pip (Debian's package drags in about 800 MB of compilers and scipy). The bot image is about 725 MB, and the bot and speech images together are about 1.4 GB unpacked; check `docker images` before adding anything big.
- **Router pinning:** the Tinfoil JS SDK picks a random router. With the egress allowlist in `tinfoil-config.yml`, the client is pinned to `https://inference.tinfoil.sh` (`createTinfoilClient` in melong.js), or requests time out at random.
- **No production logs.** Debug instances get logs (`ssh -p <port> root@debug.tinfoil.sh`, `tindbg logs`), but org secrets are injected into any instance whose config lists them, so never debug a release whose config has `secrets:`.
- **Persistent volumes** are beta, need your own key server, and force downtime on every update (no blue-green). That's why room memory is stored in Matrix instead. Tinfoil's S3 "buckets sidecar" is the other option if storage needs to grow.
- **Web search** is just `web_search_options` (plus `pii_check_options` and `prompt_injection_check_options`) on the chat request. It runs inside Tinfoil, and citations come back as inline Markdown links.

## Testing

- `npm test`: offline (no network or keys), about 4 s. It covers message and attachment handling (fake Matrix client), splitting, cross-signing, room memory storage and tools, and prompt files. Add a case to `test/messages.test.js` for every client quirk you fix.
- **Startup check before releasing changes to index.js** (the v0.3.3 crash was a `ReferenceError` in the health callback). This runs the bot against a fake homeserver, so it can't touch the real account:
  `MATRIX_HOMESERVER_URL=http://127.0.0.1:9 HEALTH_PORT=18089 MATRIX_STORAGE_PATH=/tmp/x/bot.json timeout 15 node --env-file=.env src/index.js & sleep 8; curl -s localhost:18089/health`
  Expect JSON with `"error": "connect ECONNREFUSED..."`, not a crash.
- **Live model checks:** write a throwaway script in the session scratchpad that imports `ChatClient` / `createTinfoilClient` from `src/melong.js`. Run it with `set -a; . ./.env; set +a` so the SDK reads `TINFOIL_API_KEY`. For room memory, pass a `Wiki` from a `WikiStore` built on a fake Matrix client (see `test/units.test.js`).
- **Seeing what a client sent (read-only):**
  1. Log in with the password as device `melong-diag`.
  2. Read `/rooms/<id>/messages`. In encrypted rooms the content is hidden, but event order, `m.relates_to` (threads and replies) and ciphertext length are visible: about 250–330 bytes is a short text, 1.5 KB+ a file, 19 KB+ a voice note.
  3. Log out to delete the session.

  The same session can `POST /keys/query` to check device cross-signing. This is how every attachment and thread bug here was diagnosed.

## Open threads

See TODO.md. In short:
- Real-world testing of Tibetan voice and of room memory.
- Licenses: the Ganga STT model has none stated, and MMS-TTS is CC-BY-NC.
- Monlam Melong as a Tibetan reply model, if Tinfoil hosts it.
- Multi-account support (spec in docs/, on hold).
- Room memory limits: old uploads pile up, the blue-green write window, and anyone can clear a room's memory.
- Media forensics: real-world tests, OpenTimestamps without network access, refreshing the C2PA trust lists.
