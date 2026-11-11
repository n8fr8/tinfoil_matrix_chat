# Multiple Matrix accounts in one instance (draft spec)

Status: **on hold** (2026-11-11). Ideas for later; nothing here is implemented.

## Goal

Run several Matrix accounts from one bot process and one Tinfoil Container. Possible uses:

- **Personas:** for example a general assistant, a Tibetan language tutor, and a digital security trainer, each with its own name, avatar and instructions.
- **Several homeservers:** the same bot reachable as an account on each.
- **Separation:** different communities talk to different accounts, with separate memory and settings.

The alternative needs no code: deploy another container from the same image with different settings. But each container is a separate enclave with its own Tibetan speech service, so cost and memory grow with every account. One instance with several accounts shares that cost.

## What can be shared

These don't depend on the account, so one copy serves every account:

- the Tinfoil client (inference, speech-to-text, text-to-speech, web search)
- the Tibetan speech service (`SPEECH_URL`)
- the topic prompts library (`prompts/`); each account could choose a subset
- message splitting, media conversion, the health server

Each account needs its own Matrix client, login cache, sync storage, encryption store, cross-signing key and conversation memory.

## Configuration

Keep today's variables working as the single default account, so existing deployments don't change. Add a list of extra accounts, each with a short ID that becomes a variable prefix:

```sh
MATRIX_ACCOUNTS=main,tutor          # empty or unset = single account, as today

# "main" uses today's unprefixed variables (MATRIX_USERNAME, MATRIX_PASSWORD, ...)

# "tutor" uses MATRIX_TUTOR_*; anything unset falls back to the main value
MATRIX_TUTOR_HOMESERVER_URL=https://wick.keanu.im
MATRIX_TUTOR_USERNAME=tibetantutor
MATRIX_TUTOR_PASSWORD=...           # Tinfoil secret
MATRIX_TUTOR_CROSS_SIGNING_KEY=...  # Tinfoil secret
MATRIX_TUTOR_DISPLAY_NAME=Tibetan Tutor
MATRIX_TUTOR_DEVICE_NAME=tutor-bot
MATRIX_TUTOR_COMMAND_PREFIX=
CHAT_TUTOR_SYSTEM_PROMPT=...        # the persona
CHAT_TUTOR_PROMPTS=history          # topic prompts this account may use; empty = all
CHAT_TUTOR_DEFAULT_TOPIC=           # optional: always add this topic's guidance
```

Per-account settings:

| Setting | Why per account |
|---|---|
| Homeserver URL, username, password | identity |
| Cross-signing key | each account has its own identity (see below) |
| Device name, display name | device cleanup matches by device name |
| Command prefix, autojoin | different rooms may want different behavior |
| System prompt | the persona |
| Allowed topic prompts, default topic | for example a tutor that always teaches |
| Reply model, web search, voice settings | optional; fall back to the global values |

Alternative considered: one JSON variable (`MATRIX_ACCOUNTS_JSON`) holding every account. It's more compact, but secrets would be mixed into a variable that isn't a secret, and Tinfoil secrets are injected one name each. Prefixed variables fit how Tinfoil secrets work.

Tinfoil config: every per-account secret must be listed under `secrets:` in `tinfoil-config.yml`, so adding an account means a config change and a release, not just a new secret.

## Code changes

1. **`config.js`:** `loadConfig()` returns `{ global, accounts: [...] }`. Each account object has today's Matrix fields plus its chat overrides. Validate that every account has credentials and that account IDs and device names are unique.
2. **`index.js`:** split `startBot()` into one-time setup (health server, Tinfoil client, speech service, prompts) and `startAccount(account, shared)`, run once per account. Accounts start independently, so one failing login doesn't stop the others. Each retries with backoff, as `main()` does today.
3. **Storage paths:** per account, under `data/<id>/` (sync state, credentials cache, crypto store). The default account keeps today's paths so existing local setups keep their device.
4. **`ChatClient`:** one per account, so history, system prompt and settings stay separate. Room history is then naturally keyed by account and room.
5. **Ignore our own accounts:** each account ignores messages from every account this instance runs, not just itself. Otherwise two of our bots in one room would answer each other forever.
6. **Token revoked (`M_UNKNOWN_TOKEN`):** today the process exits so the container restarts and logs in fresh. With several accounts, stop just that account, delete its cached login, and start it again in-process.
7. **Shutdown:** register `SIGINT`/`SIGTERM` once and stop every client.
8. **`npm run cross-signing -- <account>`:** sets up one account and writes `MATRIX_<ID>_CROSS_SIGNING_KEY` to `.env`.
9. **`/health`:** an `accounts` list with each one's user ID, `started`, `secondsSinceLastSync`, `crossSigning` and `error`. Top-level `ok` is true only when every account is syncing. `/diag` stays global.
10. **Logs:** prefix log lines with the account ID.

## Encryption notes

- Each account needs its own cross-signing identity and its own `MATRIX_<ID>_CROSS_SIGNING_KEY`. Without one, current Element clients won't send that account room keys after a restart (see the README, "How storage works in the container").
- Device cleanup only deletes devices with the account's own device name, so give each account a different device name.
- Blue-green updates run the old and new instance at the same time for every account. The 15-minute idle rule for deleting old devices already covers this.

## Rooms with more than one of our accounts

- **Default:** each account answers only messages addressed to it in shared rooms: a mention, a reply to its own message, or its command prefix. In a DM or a room where it's the only one of our accounts, it answers everything, as today.
- Autojoin is per account, so each account only joins rooms it's invited to.

## Resources

- Memory: each account adds a Matrix client, sync cache and Rust crypto store, roughly 100–200 MB. A 16 GB container has plenty of room for a handful.
- CPU: mostly idle sync. Inference and speech are remote or shared.
- Tinfoil usage scales with messages, not with accounts.

## Testing plan

- Unit: config parsing (single account with today's variables, several accounts, fallback to global values, duplicate IDs or device names rejected).
- Local: two test accounts on one homeserver. Check that both reply in their own DMs, neither answers the other in a shared room, and revoking one account's token restarts only that account.
- Production: add a second account, confirm `/health` shows both as `signed` and syncing, and test from Element after a restart (the cross-signing case).

## Open questions

- Should per-account personas also be able to choose the reply model (for example, Monlam Melong for a Tibetan tutor, if Tinfoil ever hosts it)?
- In shared rooms, is "only when mentioned" right, or should one account be the primary responder?
- Is there a use for one account per homeserver, which would need federation and `via` handling for each account's joins?
