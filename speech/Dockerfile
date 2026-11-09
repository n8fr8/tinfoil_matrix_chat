# Tibetan speech sidecar (MMS text-to-speech + speech-to-text, CPU only).
# Models are licensed CC-BY-NC 4.0: non-commercial use, attribution required.

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS base
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Build stage: download pinned weights and quantize the speech-to-text model.
# The 3.9 GB full-precision download stays here and is not shipped.
FROM base AS models
COPY download_models.py .
RUN python download_models.py download
RUN python download_models.py prepare /models

FROM base
COPY --from=models /models /models
COPY download_models.py server.py ./
USER 1000:1000
ENV PORT=8000 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
EXPOSE 8000
CMD ["python", "server.py"]
