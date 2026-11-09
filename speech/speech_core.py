"""Model-independent pre/post-processing for the speech sidecar, using only
NumPy, so the runtime image needs no PyTorch or transformers.

These reimplement the parts of transformers' VitsTokenizer and Wav2Vec2
processor that the MMS models use. build_models.py checks them against the
transformers originals at image build time and fails the build on any mismatch.
"""

import json
import os

import numpy as np


class VitsTokenizer:
    """Text -> input ids for facebook/mms-tts-* (VITS), matching transformers'
    VitsTokenizer for non-uroman, non-phonemized languages such as Tibetan."""

    def __init__(self, model_dir):
        with open(os.path.join(model_dir, "vocab.json"), encoding="utf-8") as f:
            self.vocab = json.load(f)
        with open(os.path.join(model_dir, "tokenizer_config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.add_blank = cfg.get("add_blank", True)
        self.normalize = cfg.get("normalize", True)
        # Vocabulary entries longer than one character are matched first, as in
        # transformers' normalize_text (which tries every vocabulary entry).
        self._entries = sorted(self.vocab, key=len, reverse=True)

    def _normalize(self, text):
        out, i = [], 0
        while i < len(text):
            for word in self._entries:
                if text.startswith(word, i):
                    out.append(word)
                    i += len(word)
                    break
            else:
                out.append(text[i].lower())
                i += 1
        return "".join(out)

    def known(self, ch):
        return ch in self.vocab

    def encode(self, text):
        if self.normalize:
            text = self._normalize(text)
        text = "".join(ch for ch in text if ch in self.vocab).strip()
        tokens = list(text)
        if not tokens:  # nothing speakable: transformers returns an empty sequence
            return np.zeros((1, 0), dtype=np.int64)
        if self.add_blank:
            spaced = [0] * (len(tokens) * 2 + 1)
            spaced[1::2] = [self.vocab[t] for t in tokens]
            return np.array([spaced], dtype=np.int64)
        return np.array([[self.vocab[t] for t in tokens]], dtype=np.int64)


class CtcProcessor:
    """Audio normalization + greedy CTC decoding for wav2vec2 CTC models,
    matching transformers' Wav2Vec2 feature extractor and tokenizer decode."""

    def __init__(self, processor_dir):
        with open(os.path.join(processor_dir, "ctc_vocab.json"), encoding="utf-8") as f:
            vocab = json.load(f)
        with open(os.path.join(processor_dir, "ctc_config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.id_to_token = {i: t for t, i in vocab.items()}
        self.pad_id = vocab[cfg["pad_token"]]
        self.word_delimiter = cfg["word_delimiter_token"]
        self.do_normalize = cfg["do_normalize"]

    def features(self, audio):
        x = np.asarray(audio, dtype=np.float32)
        if self.do_normalize:
            x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
        return x[None, :].astype(np.float32)

    def decode(self, logits):
        ids = logits.argmax(-1)
        collapsed = [int(i) for k, i in enumerate(ids) if k == 0 or i != ids[k - 1]]
        tokens = [self.id_to_token[i] for i in collapsed if i != self.pad_id]
        return "".join(" " if t == self.word_delimiter else t for t in tokens).strip()
