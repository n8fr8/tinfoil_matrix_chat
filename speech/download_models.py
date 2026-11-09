"""Prepares the model files at image build time, so the running container needs
no internet access and the weights are covered by the image digest that
Tinfoil measures.

- facebook/mms-tts-bod: downloaded as-is (145 MB).
- facebook/mms-1b-all: downloads the base weights plus only the Tibetan ("bod")
  adapter, quantizes the linear layers to int8 (about 3x faster on CPU with the
  same output in our tests) and saves just the quantized model. The 3.9 GB
  full-precision weights stay in the build stage and are not shipped.

Run: python download_models.py download            (fetch weights to the HF cache)
     python download_models.py prepare /models     (copy/quantize into /models)
"""

import sys

TTS_REPO = "facebook/mms-tts-bod"
TTS_REV = "e5767a90abf2293827ca6f467a9b964c0dc35fc5"
STT_REPO = "facebook/mms-1b-all"
STT_REV = "3d33597edbdaaba14a8e858e2c8caa76e3cec0cd"

# Paths inside the output directory.
TTS_DIR = "mms-tts-bod"
STT_PROCESSOR_DIR = "mms-1b-all-bod-processor"
STT_MODEL_DIR = "mms-1b-all-bod-int8"  # config.json + int8 state_dict


TTS_FILES = ["*.json", "model.safetensors"]
STT_FILES = ["*.json", "model.safetensors", "adapter.bod.safetensors"]


def download():
    from huggingface_hub import snapshot_download

    snapshot_download(TTS_REPO, revision=TTS_REV, allow_patterns=TTS_FILES)
    snapshot_download(STT_REPO, revision=STT_REV, allow_patterns=STT_FILES)


def remove_parametrizations(model):
    """Bakes parametrized weights (wav2vec2's weight-normed positional conv) into
    plain tensors. Inference is unchanged, and the module becomes picklable."""
    from torch.nn.utils import parametrize

    for module in model.modules():
        if parametrize.is_parametrized(module):
            for name in list(module.parametrizations):
                parametrize.remove_parametrizations(module, name, leave_parametrized=True)


def quantized_skeleton(config):
    """Builds the int8 model structure without allocating full-precision weights:
    creates the model on the "meta" device, swaps every nn.Linear for an empty
    int8 dynamic-quantized Linear, then allocates the remaining (small) layers.
    Load the saved state_dict into the result."""
    import torch
    import torch.ao.nn.quantized.dynamic as nnqd
    from transformers import Wav2Vec2ForCTC

    with torch.device("meta"):
        model = Wav2Vec2ForCTC(config)
    remove_parametrizations(model)
    for name, module in list(model.named_modules()):
        for child_name, child in list(module.named_children()):
            if type(child) is torch.nn.Linear:
                setattr(module, child_name, nnqd.Linear(child.in_features, child.out_features,
                                                        bias_=child.bias is not None, dtype=torch.qint8))
    return model.to_empty(device="cpu").eval()


def load_quantized(model_dir):
    import os

    import torch
    from transformers import Wav2Vec2Config

    config = Wav2Vec2Config.from_pretrained(model_dir)
    model = quantized_skeleton(config)
    state = torch.load(os.path.join(model_dir, "model_int8.pt"), weights_only=True)
    model.load_state_dict(state, strict=True)
    return model


def prepare(out_dir):
    import os

    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoProcessor, Wav2Vec2ForCTC

    import shutil

    tts_dir = os.path.join(out_dir, TTS_DIR)
    snapshot_download(TTS_REPO, revision=TTS_REV, allow_patterns=TTS_FILES, local_dir=tts_dir)
    shutil.rmtree(os.path.join(tts_dir, ".cache"), ignore_errors=True)  # download bookkeeping

    proc = AutoProcessor.from_pretrained(STT_REPO, revision=STT_REV, target_lang="bod")
    proc.save_pretrained(os.path.join(out_dir, STT_PROCESSOR_DIR))
    model = Wav2Vec2ForCTC.from_pretrained(STT_REPO, revision=STT_REV, target_lang="bod",
                                           ignore_mismatched_sizes=True).eval()
    remove_parametrizations(model)
    model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    model_dir = os.path.join(out_dir, STT_MODEL_DIR)
    os.makedirs(model_dir, exist_ok=True)
    model.config.save_pretrained(model_dir)  # includes the Tibetan vocab size
    torch.save(model.state_dict(), os.path.join(model_dir, "model_int8.pt"))
    print("saved models to", out_dir)


if __name__ == "__main__":
    if sys.argv[1] == "download":
        download()
    else:
        prepare(sys.argv[2])
