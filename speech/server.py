"""Tibetan speech sidecar for the Melong bot.

Runs Meta's MMS models on CPU and serves them over HTTP on the enclave's
internal network (no internet access):

  GET  /health  {"ok": true, ...} once both models are loaded
  POST /tts     JSON {"text": "<Tibetan text>"}       -> audio/wav (16 kHz mono)
  POST /stt     audio/wav body (16 kHz mono PCM16)    -> JSON {"text": "..."}

Models (prepared at image build time from pinned revisions, see download_models.py):
  facebook/mms-tts-bod                  text-to-speech (VITS)
  facebook/mms-1b-all + "bod" adapter   speech-to-text (wav2vec2 CTC)
Both are licensed CC-BY-NC 4.0 (non-commercial use, attribution required).
"""

import io
import json
import os
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from transformers import AutoProcessor, AutoTokenizer, VitsModel

PORT = int(os.environ.get("PORT", "8000"))
THREADS = int(os.environ.get("TORCH_THREADS", "2"))
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
MAX_TEXT_CHARS = 5000
MAX_AUDIO_SECONDS = 600
STT_CHUNK_SECONDS = 20  # bounds memory/latency per forward pass
SAMPLE_RATE = 16000

from download_models import STT_MODEL_DIR, STT_PROCESSOR_DIR, TTS_DIR, load_quantized  # noqa: E402

torch.set_num_threads(THREADS)
state = {"ready": False, "error": None, "loaded_at": None}
lock = threading.Lock()  # one inference at a time; the CPUs are shared
models = {}


def log(msg):
    print(f"[speech] {msg}", flush=True)


def load_models():
    try:
        t = time.time()
        tts_dir = os.path.join(MODELS_DIR, TTS_DIR)
        models["tts_tok"] = AutoTokenizer.from_pretrained(tts_dir)
        models["tts"] = VitsModel.from_pretrained(tts_dir).eval()
        models["tts_vocab"] = set(models["tts_tok"].get_vocab())
        log(f"TTS loaded in {time.time() - t:.1f}s")

        t = time.time()
        models["stt_proc"] = AutoProcessor.from_pretrained(os.path.join(MODELS_DIR, STT_PROCESSOR_DIR))
        # int8 weights prepared at build time (download_models.py).
        models["stt"] = load_quantized(os.path.join(MODELS_DIR, STT_MODEL_DIR))
        log(f"STT loaded in {time.time() - t:.1f}s")
        state.update(ready=True, loaded_at=time.time())
    except Exception as e:  # report on /health instead of crashing
        state["error"] = f"{type(e).__name__}: {e}"
        log(f"model load failed: {state['error']}")


# ---- Text-to-speech -------------------------------------------------------

# Sentence breaks: shad / nyis shad / other Tibetan marks, newlines, Latin punctuation.
SENTENCE_SPLIT = re.compile(r"[།-༒༔\n.!?;:]+")
MAX_CHUNK_CHARS = 300


def tts_chunks(text):
    """Splits text into speakable chunks of characters the model knows."""
    vocab = models["tts_vocab"]
    chunks = []
    for sentence in SENTENCE_SPLIT.split(text):
        # Keep only characters in the model's vocabulary (Tibetan letters, tsheg, space).
        cleaned = re.sub(r"\s+", " ", "".join(ch if ch in vocab else " " for ch in sentence)).strip(" ་")
        while len(cleaned) > MAX_CHUNK_CHARS:  # split long runs at a syllable boundary
            cut = cleaned.rfind("་", 0, MAX_CHUNK_CHARS)
            cut = cut if cut > 0 else MAX_CHUNK_CHARS
            chunks.append(cleaned[: cut + 1])
            cleaned = cleaned[cut + 1 :].strip(" ་")
        if cleaned:
            chunks.append(cleaned)
    return chunks


def synthesize(text):
    chunks = tts_chunks(text)
    if not chunks:
        raise ValueError("no speakable Tibetan text")
    sr = models["tts"].config.sampling_rate
    pause = np.zeros(int(sr * 0.25), dtype=np.float32)
    parts = []
    with lock, torch.no_grad():
        for chunk in chunks:
            inputs = models["tts_tok"](chunk, return_tensors="pt")
            parts += [models["tts"](**inputs).waveform[0].numpy(), pause]
    return to_wav(np.concatenate(parts[:-1]), sr)


def to_wav(audio, sr):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---- Speech-to-text -------------------------------------------------------

def read_wav(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != SAMPLE_RATE:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(data):
    audio = read_wav(data)
    if len(audio) > MAX_AUDIO_SECONDS * SAMPLE_RATE:
        raise ValueError(f"audio longer than {MAX_AUDIO_SECONDS}s")
    proc, model = models["stt_proc"], models["stt"]
    step = STT_CHUNK_SECONDS * SAMPLE_RATE
    texts = []
    with lock, torch.no_grad():
        for start in range(0, max(len(audio), 1), step):
            piece = audio[start : start + step]
            if len(piece) < SAMPLE_RATE // 4:  # skip slivers under 0.25s
                continue
            inputs = proc(piece, sampling_rate=SAMPLE_RATE, return_tensors="pt")
            ids = model(**inputs).logits.argmax(-1)[0]
            texts.append(proc.decode(ids).strip())
    return " ".join(t for t in texts if t)


# ---- HTTP -----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet access logs
        pass

    def send(self, code, body, content_type="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            ok = state["ready"]
            return self.send(200 if ok else 503, {"ok": ok, "error": state["error"]})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if not state["ready"]:
            return self.send(503, {"error": state["error"] or "models still loading"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 50 * 1024 * 1024:
            return self.send(400, {"error": "missing or too-large body"})
        body = self.rfile.read(length)
        t = time.time()
        try:
            if self.path == "/tts":
                text = json.loads(body).get("text", "")[:MAX_TEXT_CHARS]
                audio = synthesize(text)
                log(f"tts {len(text)} chars in {time.time() - t:.1f}s")
                return self.send(200, audio, "audio/wav")
            if self.path == "/stt":
                text = transcribe(body)
                log(f"stt {length} bytes in {time.time() - t:.1f}s")
                return self.send(200, {"text": text})
            self.send(404, {"error": "not found"})
        except (ValueError, wave.Error, json.JSONDecodeError, EOFError) as e:
            self.send(400, {"error": str(e) or type(e).__name__})
        except Exception as e:
            log(f"{self.path} failed: {type(e).__name__}: {e}")
            self.send(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    threading.Thread(target=load_models, daemon=True).start()
    log(f"listening on 0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
