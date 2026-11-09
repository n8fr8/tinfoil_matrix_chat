# Tibetan speech models: research notes

How the bot's Tibetan speech-to-text (STT), text-to-speech (TTS), language
routing and reply model were chosen, with the measurements behind each choice.
Work done November 2026 for the Melong Matrix bot prototype.

## Summary

| Job | Choice | Why |
|---|---|---|
| Tibetan speech-to-text | `ganga4364/wav2vec2-combine-dialect-model-v2-47000` (int8 ONNX in the `speech/` sidecar) | 26% character error rate on real Tibetan speech, vs 60% for Meta's MMS; a third of the size |
| Tibetan text-to-speech | `facebook/mms-tts-bod` (ONNX in the sidecar) | The only usable open Tibetan TTS model found; fast on CPU |
| Other languages, speech-to-text | Tinfoil's hosted `whisper-large-v3-turbo` | Good transcripts, and its confidence score tells Tibetan apart from other languages |
| Tibetan vs other language routing | Whisper's confidence, threshold −0.45 | 58 of 59 real clips routed correctly |
| Chat / reply model | Tinfoil's hosted `deepseek-v4-1-flash` (briefly `kimi-k3`; originally `gemma4-31b`) | Clean Tibetan script and ~4 s for a Tibetan answer; Gemma mixed in other scripts, Kimi took 20–40 s |

## Constraints

- **Everything runs inside the Tinfoil enclave.** Audio never leaves it, which
  rules out hosted Tibetan services such as Monlam AI's speech-to-text.
- **4 GB image ramdisk.** With less than 32 GB of enclave memory, all container
  images share a fixed 4 GB ramdisk (compressed + unpacked). Both images must
  fit, so the sidecar uses ONNX Runtime and NumPy instead of PyTorch.
- **CPU only.** The enclave has no GPU; models must run in a few seconds on
  2 CPUs.

## Test data

Real human speech, fetched as single rows from public Hugging Face datasets:

| Set | Clips | Content | Reference |
|---|---|---|---|
| `lilgoose777/tibetan-chinese-english-speech` | 8 Tibetan | Short colloquial sentences (2–3 s), likely Amdo-influenced dialect | Tibetan text + human English translation |
| `Titung/tibetan-to-english-audio-dataset` | 8 Tibetan | Formal read sentences (8–10 s) | Tibetan text + loose English translation |
| `google/fleurs` test split | 8 each: English, French, Hindi, Mandarin, Nepali | Read Wikipedia sentences | Text |
| Synthetic | 2 Tibetan (MMS TTS), 1 English (Voxtral TTS) | Short sentences | Known text |

Character error rate (CER) is the edit distance between the model's output and
the reference, counted over Tibetan letters and vowel signs only (syllable dots,
spaces and punctuation ignored), divided by the reference length.

**Caveat:** 16 Tibetan clips is a small sample, and none of the models says what
it was trained on, so a model may have seen some of these clips. The
`HNO333333` result below almost certainly did. The ranking should be confirmed on
fresh recordings (for example, real voice notes sent to the bot).

## Speech-to-text comparison

All models run with Hugging Face `transformers` on CPU, greedy decoding, on the
16 real Tibetan clips.

| Model | Type / size | CER overall | Colloquial (lilgoose) | Formal (Titung) | Notes |
|---|---|---|---|---|---|
| `facebook/mms-1b-all` + `bod` adapter | wav2vec2, 1B | 0.603 | 0.700 | 0.577 | Previous choice. Trained mostly on read religious text |
| **`ganga4364/wav2vec2-combine-dialect-model-v2-47000`** | wav2vec2, 300M | **0.262** | **0.371** | **0.233** | **Chosen.** OpenPecha developer; "combined dialects" |
| `HNO333333/w2v-bert-2.0-Tibetan-Amdo` | w2v-BERT 2.0, 600M | 0.137 | 0.547 | 0.024 | 2% on Titung is implausible: almost certainly trained on it. Worse than Ganga's on colloquial speech |
| `openpecha/op-wav2vec2-ft-v17` | wav2vec2, 300M | 0.432 | 0.653 | 0.372 | |
| `openpecha/op-whisper_small-ft-v2` | Whisper small, 240M | 0.477 | 0.712 | 0.412 | Outputs Wylie romanization (converted with `pyewts` for scoring); 8x slower |
| `openpecha/general_stt_base_model` | wav2vec2, 300M | 0.503 | 0.629 | 0.468 | |
| `TenzinGayche/tibetan-whisper-small` | Whisper small | 0.530 | 0.712 | 0.480 | |
| `tenzin/whisper-small-tibetan` | Whisper small | 0.561 | 0.718 | 0.519 | Very slow (sometimes loops) |
| `billingsmoore/tibetan-asr-nict-tib1-wav2vec2-base` | wav2vec2 base, 95M | 0.660 | 0.741 | 0.638 | Apache-2.0 |
| `billingsmoore/tibetan-asr-nict-tib1-whisper-small` | Whisper small | n/a | | | Could not load: no feature-extractor config in the repo |

Example, "We have graduated" (reference ངུ་ཆོ་མཐར་ཕྱིན་སོང་ནི་རེད།):

| Model | Output |
|---|---|
| MMS (previous) | མུ་ཆུ་ཐར་བཞིན་བསོང་དྲི |
| Ganga combined-dialect | ངུ་ཁྱོད་ཐར་ཕྱིན་སོང་ནི་རེད། |
| HNO Amdo | ངི ཆོར མཐར ཕྱིན སོང དས |
| OpenPecha Whisper (Wylie) | nga tsho thar phyin song e 'dra'i |

**Accuracy after conversion.** The sidecar runs the chosen model as int8 ONNX.
Measured through the sidecar's own `/stt` endpoint on the same 16 clips:
CER **0.267** (colloquial 0.382, formal 0.236), against 0.262 before
quantization: practically no loss. The image is 692 MB (previously 1.34 GB with
`mms-1b-all`); the sidecar is ready in ~4 s and uses ~1 GB of memory (was
~1.7 GB). End to end through the bot, the colloquial clip "What do you need?
I'll get it for you" (ཁྱོས་ཆི་ཟིག་དགོས་ན་ངས་འཁྱེར་ཡོང།) was transcribed as
ཁྱོད་ཅི་ཟེད་དགོས་ནས་ངས་ཁྱེ་ར་ཡོང།, and Gemma answered it sensibly (though
with an Italian word, "bisogno", mixed into its Tibetan reply).

### Not available

- **Monlam AI** publishes no speech models on Hugging Face (only
  `MonlamAI/tibetan_RoBERTa_S_e6`, a text model). Its speech-to-text is offered
  as a hosted service on monlam.ai, which would send audio outside the enclave.
- Most other OpenPecha / `ganga4364` speech models are fine-tuned on a single
  teacher's voice (Garchen Rinpoche, Situ Rinpoche, Dilgo Khyentse Rinpoche) and
  were not tested.

### Licenses

| Model | License |
|---|---|
| `facebook/mms-tts-bod` (TTS, in use) | CC-BY-NC 4.0: non-commercial, attribution |
| `ganga4364/wav2vec2-combine-dialect-model-v2-47000` (STT, in use) | **None stated** on the model card. Ask the author / OpenPecha before any use beyond this prototype |
| `facebook/mms-1b-all` (previous STT) | CC-BY-NC 4.0 |
| `billingsmoore/*` | Apache-2.0 |
| `tenzin/whisper-small-tibetan` | CC-BY-NC-SA 4.0 |
| `TenzinGayche/tibetan-whisper-small` | Apache-2.0 |
| Other OpenPecha / HNO models | None stated |

## Language routing (Tibetan vs other languages)

A voice note can be in any language, and the Tibetan model writes everything in
Tibetan script, so the bot has to decide which transcript to use.

| Signal | Result |
|---|---|
| MMS (Tibetan model) confidence, mean max-probability | **Useless**: 0.76–0.92 for every language |
| Whisper's detected language | **Unreliable for Tibetan**: Tibetan was labelled Kazakh, Chinese, Welsh, Korean, Belarusian, French, English |
| Whisper's confidence (duration-weighted mean `avg_logprob`) | **Works**: Tibetan scored ≤ −0.58 or produced no text (9 of 16); other languages scored ≥ −0.33 (one Nepali clip, misdetected as Welsh, at −1.33) |

Rule (`SPEECH_STT=auto`): if Whisper returns text with confidence ≥ −0.45, use
Whisper's transcript; otherwise use the Tibetan model's. Result on 59 clips:
all 18 Tibetan clips and 40 of 41 others routed correctly. Tune with
`SPEECH_DETECT_THRESHOLD` if real phone recordings behave differently.

## Text-to-speech

`facebook/mms-tts-bod` speaks Tibetan script only. Replies are split by script:
Tibetan runs go to MMS, everything else to Tinfoil's `voxtral-tts`, and the
clips are joined into one voice message. Earlier, a reply was sent to MMS only
when more than half its letters were Tibetan, so short Tibetan replies with an
English gloss were wrongly spoken by Voxtral.

## Reply model (LLM)

Tested on Tinfoil's chat models with (a) translating the 10 Tibetan sentences
above to English, from the clean reference text and from MMS transcripts, and
(b) answering two questions in Tibetan.

- **From the old MMS transcripts, every model failed.** The transcripts were too
  garbled; models either gave up ("unclear") or invented fluent but wrong
  sentences. Speech-to-text quality was the bottleneck.
- **From clean Tibetan text,** Gemma 4, Llama 3.3 70B and gpt-oss-120b each got
  roughly half the colloquial sentences right. The reasoning models (Kimi K3 /
  K3.1 Pro, DeepSeek V4.1 Flash, GLM 5.3) often ran out of a 12,000-token budget
  while thinking, taking up to 4.5 minutes.
- **Writing Tibetan:** Gemma 4 mixes other scripts into Tibetan replies (Spanish
  "llegado", Chinese 亲戚 / 风俗, Devanagari, Sinhala, Burmese: up to 13% of
  letters). Kimi K3, DeepSeek V4.1 Flash, GLM 5.3 and Llama 3.3 wrote clean
  Tibetan script; DeepSeek was fastest (3–5 s). Fluency has not been judged by
  a native speaker.

**First switch: `kimi-k3`.** Checked as a general chat model before switching: chat
6–8 s, image description 7 s, document summary 9 s, a Tibetan question ~30 s
(about 1,500 tokens, mostly reasoning). Because reasoning counts against the
token limit, `CHAT_MAX_NEW_TOKENS` went from 2,048 to 16,000 and the request
timeout to 5 minutes. End to end, the real voice note "What do you need? I'll
get it for you" got a sensible reply in clean Tibetan (36 s in total).
`reasoning_effort: "low"` is accepted but did not make Tibetan answers faster.

**Then: `deepseek-v4-1-flash`** (current). Same prompts, one request at a time,
three runs each:

| Task | DeepSeek V4.1 Flash | Kimi K3 |
|---|---|---|
| Short English chat | 0.4–0.6 s (13 s on a cold first call) | 1.7–2.8 s |
| Tibetan question (Losar traditions) | 3.9–8.0 s | 25–40 s |
| Reply to a Tibetan voice-note transcript | 2.4–4.5 s | 20–31 s |
| Other scripts mixed into Tibetan | none | none |

Both understood the voice note the same way. DeepSeek translated the eight
colloquial sentences at least as well as Kimi, in 12 s against 90 s. Known risk:
on two ambiguous translation jobs it reasoned until a 12,000-token limit
(~40 s); the bot now has a 16,000-token limit and reports running out clearly.

### Monlam Melong (tested, not used)

`TenzinGayche/Monlam_Melong_preview` is Monlam AI's Tibetan LLM: Gemma 2 9B
fine-tuned from `buddhist-nlp/gemma2-mitra-base`, 18.5 GB in bf16, license
"to be added". Tinfoil doesn't host it.

Tested locally: converted to 8-bit GGUF with llama.cpp (the repo lacks
`tokenizer.model`; the base model's was used, same 256k vocabulary) and run on
an 8-core CPU, against DeepSeek V4.1 Flash on Tinfoil with the same prompts:

| Test | Monlam Melong (q8_0, CPU) | DeepSeek V4.1 Flash |
|---|---|---|
| Losar traditions, in Tibetan | Clean, fluent, more detail. 226 s | Clean; a couple of slips ("Gregorian 29th", misspelt *dgu thug*). 3.6 s |
| Why drink water, in Tibetan | Clean. 113 s | Clean. 5.6 s |
| Reply to voice note "What do you need? I'll get it for you" | Repeated the message back instead of replying. 17 s | Sensible reply ("I don't need anything, thank you"). 2.0 s |
| Tibetan to English, 8 colloquial sentences | ~3.5 right | ~3.5 right |
| English to Tibetan | Natural colloquial phrasing | Correct, more formal |
| Speed | ~1.6 tokens/s | 2–6 s per answer |

Both translated ངུ་ཆོ་མཐར་ཕྱིན་སོང་ནི་རེད། ("We have graduated") as "The
crying has stopped", reading ངུ as "cry". Conclusion: Melong's Tibetan may be
more natural (needs a native speaker to judge), but it is a weaker chat
assistant and unusably slow on CPU. Running it ourselves needs a GPU enclave
(`tinfoil model wrap` + vLLM; 1 GPU, ~16 CPUs, 64 GB in Tinfoil's example),
too expensive for this prototype. Asking Tinfoil to host it is the cheapest
route if it's wanted later.

## Reproducing

The scripts lived in the session scratchpad; the essentials:

1. Fetch rows: open the dataset's Parquet file over HTTP with `fsspec` +
   `pyarrow.parquet` and read the first batch (the Hugging Face dataset viewer
   API returned 502s at the time).
2. Score: `transformers.pipeline("automatic-speech-recognition", model=...)` on
   16 kHz mono audio; for `facebook/mms-1b-all` load the processor and model
   with `target_lang="bod"`; convert Wylie output with `pyewts`.
3. Routing: call Tinfoil's `whisper-large-v3-turbo` with
   `response_format: "verbose_json"` and average segment `avg_logprob`
   weighted by duration.
