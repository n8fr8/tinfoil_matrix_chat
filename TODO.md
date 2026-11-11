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
