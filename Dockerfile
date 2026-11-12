# Melong Matrix chatbot. Built for Tinfoil Containers (see tinfoil-config.yml),
# but runs anywhere Docker does.

# Debian (glibc) base: the Matrix Rust crypto module ships glibc binaries.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# ca-certificates for TLS to the homeserver and Tinfoil.
# PDF documents (src/pdf.js): WeasyPrint renders HTML to PDF with Pango and
# HarfBuzz, which shape Tibetan, Devanagari and CJK correctly, using Noto fonts.
# Installed with pip (versions pinned in requirements-pdf.txt) on top of only
# the Pango libraries: Debian's weasyprint package pulls in ~800 MB of compilers
# and scientific libraries. Adds ~290 MB, mostly fonts.
COPY requirements-pdf.txt /tmp/requirements-pdf.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
       python3 python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
       fonts-noto-core fonts-noto-cjk \
    && python3 -m venv /opt/weasyprint \
    && /opt/weasyprint/bin/pip install --no-cache-dir -r /tmp/requirements-pdf.txt \
    && apt-get purge -y python3-venv && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/requirements-pdf.txt
ENV WEASYPRINT=/opt/weasyprint/bin/weasyprint

# ffmpeg converts voice messages / audio / video for transcription and builds
# voice replies. A single static binary (145 MB) instead of Debian's ffmpeg
# package (465 MB of libraries): inside a Tinfoil enclave all container images
# must fit in a 4 GB ramdisk.
COPY --from=mwader/static-ffmpeg@sha256:f698cee4f6d63a0ee5a80df40b093aae96a80c06e27836736b2347208bd13dc2 /ffmpeg /usr/local/bin/ffmpeg

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY prompts ./prompts

# Runtime state (sync token, crypto store, cached login) lives here. In a Tinfoil
# Container this is a tmpfs, so it is wiped on restart.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV HEALTH_PORT=8080
EXPOSE 8080

# Settings come from the environment (tinfoil-config.yml env + secrets), not .env.
CMD ["node", "src/index.js"]
