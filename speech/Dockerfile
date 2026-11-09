# Tibetan speech sidecar (MMS text-to-speech + speech-to-text, CPU only).
# Models are licensed CC-BY-NC 4.0: non-commercial use, attribution required.
#
# Inside a Tinfoil enclave all container images share a 4 GB ramdisk, so the
# runtime image carries only ONNX Runtime, NumPy and the exported models.
# PyTorch and transformers are used only in the build stage.

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS base
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Build stage: download pinned weights, export to ONNX, quantize, self-test.
FROM base AS models
COPY requirements-build.txt .
RUN pip install -r requirements-build.txt
# Plain HTTP downloads (the hf_xet transfer client failed intermittently).
ENV HF_HUB_DISABLE_XET=1
COPY build_models.py ./
RUN python build_models.py download
COPY speech_core.py ./
RUN python -W ignore build_models.py /models

FROM base
COPY requirements.txt .
RUN pip install -r requirements.txt && pip uninstall -y pip setuptools wheel 2>/dev/null; true
COPY --from=models /models /models
COPY speech_core.py server.py ./
USER 1000:1000
ENV PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
