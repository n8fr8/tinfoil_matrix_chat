"""Builds the speech sidecar's model files (runs only in the image's build stage).

1. Downloads the pinned models from Hugging Face:
     facebook/mms-tts-bod                    text-to-speech (VITS)
     ganga4364/wav2vec2-combine-dialect-model-v2-47000
                                             speech-to-text (wav2vec2 CTC, 300M,
                                             Tibetan, several dialects; from an
                                             OpenPecha developer)
2. Exports both to ONNX, so the runtime image needs only onnxruntime + NumPy
   (no PyTorch). Inside a Tinfoil enclave all container images share a 4 GB
   ramdisk, and PyTorch alone is ~1.2 GB.
3. Quantizes the speech-to-text model to int8 (~320 MB instead of 1.26 GB,
   faster on CPU; see docs/tibetan-speech-models.md for the accuracy check).
4. Self-tests: the NumPy pre/post-processing in speech_core.py must match
   transformers exactly, and both ONNX models must run. Any mismatch fails the build.

mms-tts-bod is licensed CC-BY-NC 4.0 (non-commercial use, attribution
required). The speech-to-text model has no license stated on its model card.

Run: python build_models.py download        (fetch weights; separate cached step)
     python build_models.py /models         (export, quantize, self-test)
"""

import json
import os
import shutil
import sys
import tempfile

TTS_REPO = "facebook/mms-tts-bod"
TTS_REV = "e5767a90abf2293827ca6f467a9b964c0dc35fc5"
STT_REPO = "ganga4364/wav2vec2-combine-dialect-model-v2-47000"
STT_REV = "42cfa2068cb30a95192b62c2ce597e96d3626574"

TTS_DIR = "tts"   # tts.onnx + vocab.json + tokenizer_config.json
STT_DIR = "stt"   # stt_int8.onnx + ctc_vocab.json + ctc_config.json

SAMPLE_TEXTS = [
    "ཁྱེད་རང་སྐུ་གཟུགས་བདེ་པོ་ཡིན་པས། ང་ནི་བོད་སྐད་ཀྱི་རོགས་རམ་པ་ཞིག་ཡིན།",
    "བཀྲ་ཤིས་བདེ་ལེགས། Hello 123!",
    "ཀ",
    "",
    "   མཐའ་མ།  ",
]


def download():
    """Fetches only the needed files, with retries."""
    import time

    from huggingface_hub import snapshot_download

    jobs = [(TTS_REPO, TTS_REV, ["*.json", "model.safetensors"]),
            (STT_REPO, STT_REV, ["*.json", "model.safetensors"])]
    for repo, rev, patterns in jobs:
        for attempt in range(1, 5):
            try:
                snapshot_download(repo, revision=rev, allow_patterns=patterns)
                break
            except Exception as e:
                if attempt == 4:
                    raise
                print(f"download of {repo} failed ({type(e).__name__}); retry {attempt}/3", flush=True)
                time.sleep(15 * attempt)


def export_tts(out_dir):
    import torch
    from transformers import AutoTokenizer, VitsModel

    tok = AutoTokenizer.from_pretrained(TTS_REPO, revision=TTS_REV)
    model = VitsModel.from_pretrained(TTS_REPO, revision=TTS_REV).eval()

    class Waveform(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids):
            return self.m(input_ids=input_ids).waveform

    ids = tok(SAMPLE_TEXTS[0], return_tensors="pt").input_ids
    torch.onnx.export(Waveform(model), (ids,), os.path.join(out_dir, "tts.onnx"),
                      input_names=["input_ids"], output_names=["waveform"],
                      dynamic_axes={"input_ids": {1: "tokens"}, "waveform": {1: "samples"}},
                      opset_version=17, dynamo=False)
    # Tokenizer files for speech_core.VitsTokenizer.
    tok.save_pretrained(out_dir)
    for name in os.listdir(out_dir):
        if name not in ("tts.onnx", "vocab.json", "tokenizer_config.json"):
            os.remove(os.path.join(out_dir, name))
    with open(os.path.join(out_dir, "sampling_rate.txt"), "w") as f:
        f.write(str(model.config.sampling_rate))
    return tok


def export_stt(out_dir):
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoProcessor, Wav2Vec2ForCTC

    proc = AutoProcessor.from_pretrained(STT_REPO, revision=STT_REV)
    model = Wav2Vec2ForCTC.from_pretrained(STT_REPO, revision=STT_REV).eval()
    dummy = torch.zeros(1, 16000)
    with tempfile.TemporaryDirectory() as tmp:
        fp32 = os.path.join(tmp, "stt_fp32.onnx")
        torch.onnx.export(model, (dummy,), fp32, input_names=["input_values"], output_names=["logits"],
                          dynamic_axes={"input_values": {1: "samples"}, "logits": {1: "frames"}},
                          opset_version=17, dynamo=False)
        del model  # free the PyTorch model before quantizing
        import gc
        gc.collect()
        quantize_dynamic(fp32, os.path.join(out_dir, "stt_int8.onnx"), weight_type=QuantType.QInt8)

    tk = proc.tokenizer
    vocab = tk.get_vocab()
    with open(os.path.join(out_dir, "ctc_vocab.json"), "w", encoding="utf-8") as f:
        json.dump(vocab, f, ensure_ascii=False)
    with open(os.path.join(out_dir, "ctc_config.json"), "w", encoding="utf-8") as f:
        json.dump({"pad_token": tk.pad_token, "word_delimiter_token": tk.word_delimiter_token,
                   "do_normalize": proc.feature_extractor.do_normalize}, f)
    return proc


def self_test(out_dir, hf_tok, hf_proc):
    import numpy as np
    import onnxruntime as ort

    from speech_core import CtcProcessor, VitsTokenizer

    # 1. Tokenizer must match transformers exactly.
    ours = VitsTokenizer(os.path.join(out_dir, TTS_DIR))
    for text in SAMPLE_TEXTS:
        expected = hf_tok(text, return_tensors="np").input_ids.astype(np.int64)
        got = ours.encode(text)
        assert got.shape == expected.shape and (got == expected).all(), f"tokenizer mismatch for {text!r}"

    # 2. Text-to-speech runs and produces audio.
    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    tts = ort.InferenceSession(os.path.join(out_dir, TTS_DIR, "tts.onnx"), so, providers=["CPUExecutionProvider"])
    audio = tts.run(None, {"input_ids": ours.encode(SAMPLE_TEXTS[0])})[0][0]
    assert 1.0 < len(audio) / 16000 < 10.0, f"unexpected TTS length {len(audio)}"

    # 3. Audio normalization and CTC decoding must match transformers.
    ctc = CtcProcessor(os.path.join(out_dir, STT_DIR))
    expected = hf_proc(audio, sampling_rate=16000, return_tensors="np").input_values
    assert np.allclose(ctc.features(audio), expected, atol=1e-5), "feature normalization mismatch"
    stt = ort.InferenceSession(os.path.join(out_dir, STT_DIR, "stt_int8.onnx"), so, providers=["CPUExecutionProvider"])
    logits = stt.run(None, {"input_values": ctc.features(audio)})[0][0]
    assert ctc.decode(logits) == hf_proc.decode(logits.argmax(-1)), "CTC decode mismatch"
    rng = np.random.default_rng(0)
    for _ in range(50):  # random logits exercise repeats, pads and word delimiters
        fake = rng.normal(size=(40, logits.shape[-1])).astype(np.float32)
        fake[rng.integers(0, 40, 10), ctc.pad_id] += 5
        assert ctc.decode(fake) == hf_proc.decode(fake.argmax(-1)), "CTC decode mismatch (random)"

    # 4. The int8 ONNX speech-to-text model transcribes the TTS output.
    text = ctc.decode(logits)
    print("self-test round trip:", SAMPLE_TEXTS[0], "->", text)
    assert len(text) > 10, "STT produced no text"


def main(out_dir):
    for d in (TTS_DIR, STT_DIR):
        os.makedirs(os.path.join(out_dir, d), exist_ok=True)
    tok = export_tts(os.path.join(out_dir, TTS_DIR))
    proc = export_stt(os.path.join(out_dir, STT_DIR))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    self_test(out_dir, tok, proc)
    print("models ready in", out_dir)


if __name__ == "__main__":
    if sys.argv[1] == "download":
        download()
    else:
        main(sys.argv[1])
