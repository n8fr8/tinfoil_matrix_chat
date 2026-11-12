# TODO

Follow-ups for the Tibetan voice features. Background and test results are in [docs/tibetan-speech-models.md](docs/tibetan-speech-models.md).

## Testing

- [ ] Send real Tibetan and English voice notes from several speakers. The test clips may overlap with the models' training data, so real recordings are a better check.
- [ ] Check that each voice note goes to the right speech model. The bot logs `Speech detection: language=.. score=.. -> general|Tibetan` for each one. If notes are misrouted, adjust `SPEECH_DETECT_THRESHOLD` (default `-0.45`; lower values send more audio to Whisper).
- [ ] Have a native speaker review the bot's written and spoken Tibetan. So far it has only been scored automatically.

## Licensing

- [ ] Ask OpenPecha/Ganga about the license for `ganga4364/wav2vec2-combine-dialect-model-v2-47000` (speech-to-text). It has no stated license.
- [ ] `facebook/mms-tts-bod` (Tibetan voice) is CC-BY-NC, so it's non-commercial only. Fine for the prototype, but needs a decision before wider use.

## Reply model

- [ ] Consider Monlam Melong (`Monlam_Melong_preview`) for Tibetan replies. Its Tibetan reads more natural, but it's weaker as a chat assistant and too slow on CPU (about 1.6 tokens/s). Asking Tinfoil to host it is cheaper than running our own GPU instance.

## Multiple accounts (on hold)

- [ ] Run several Matrix accounts (personas) from one instance. Draft spec: [docs/multi-account-spec.md](docs/multi-account-spec.md).

## Room memory (wikis)

- [ ] Test in Matrix: "remember this" (also as a reply to a message or file), a question answered from memory, `!memory check`, `!memory export`, and a restart (the memory should reload).
- [ ] Old wiki versions pile up on the homeserver as encrypted uploads (bots can't delete media). Fine for now; consider asking the homeserver admin to purge old media, or saving less often.
- [ ] During a blue-green update the old and new instance both run for a few minutes; a wiki change in that window could be overwritten by the other instance.
- [ ] Anyone in a room can change or clear its wiki. Consider limiting `!memory clear` to room moderators.

## Media forensics

- [ ] Test in Matrix: a C2PA photo (e.g. from a Pixel), the same photo sent as a compressed image, an edited copy, a ProofMode proof bundle, and a video.
- [ ] Ask the ProofMode team to review `prompts/osint.md` and the `inspect_media` report (src/forensics.js).
- [ ] Notes for the ProofMode team, from testing real bundles with proofmode-rust v0.9.0:
  - The v0.9.0 tag's `Cargo.lock` lists the crate as 0.8.4, so `cargo build --locked` fails (the Dockerfile patches that line).
  - `proofmode check -o` writes every file's bytes and the PGP keys as pretty-printed number arrays: 777 MB of JSON for a 61 MB bundle. The bot streams it through a filter (`JsonByteArrayFilter`); an option to leave the bytes out would help everyone.
  - OpenTimestamps shows `verified: true` when the proof only parsed and is still pending at a calendar.
  - Location "outlier" flags fire on differences of centimetres (z-scores on a std of 0.000002°), and the EXIF vs ProofMode model check flags "SM-S918U1" vs "Samsung SM-S918U1" as an error.
  - `createdAt` in `.proof.json` is local time with a `Z` (UTC) suffix.
- [ ] OpenTimestamps: the report shows each proof's attestations as stored in the bundle (often "Pending" at a calendar). Upgrading a pending proof to its Bitcoin anchor needs network access to the calendars, which the egress allowlist blocks. Consider allowing them.
- [ ] The C2PA trust lists in `c2pa-trust/` are a snapshot; refresh them (`npm run c2pa-trust`) every release or two. The interim (legacy) list is being retired.
- [ ] Recent files are kept in memory per room (6 files, 2 hours) for follow-up questions; they're lost on restart. Check that's enough in practice.
