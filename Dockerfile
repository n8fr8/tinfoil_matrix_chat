# Melong Matrix chatbot. Built for Tinfoil Containers (see tinfoil-config.yml),
# but runs anywhere Docker does.

# Media forensics tools for the inspect_media tool (src/forensics.js), built from
# source on Debian 12 so they run on the same glibc as the bot image (the c2patool
# release binaries need glibc 2.39; Debian 12 has 2.36).
#   c2patool:  Content Credentials (C2PA) reader/validator, crates.io release + its Cargo.lock
#   proofmode: Guardian Project's proofmode-rust, for checking ProofMode proof bundles
FROM rust:1.94-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS forensics-tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev perl make clang llvm nettle-dev \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install c2patool --version 0.27.22 --locked --root /out
ARG PROOFMODE_TAG=v0.9.0
ARG PROOFMODE_COMMIT=88d9ffd2b812b4819408f26dba179d288f72e1b2
RUN git clone --depth 1 --branch "$PROOFMODE_TAG" https://gitlab.com/guardianproject/proofmode/proofmode-rust.git /src/proofmode \
    && test "$(git -C /src/proofmode rev-parse HEAD)" = "$PROOFMODE_COMMIT" \
    # v0.9.0's Cargo.lock still lists the crate itself as 0.8.4 (dependencies are unchanged); fix that one line.
    && sed -i '/^name = "proofmode"$/{n;s/^version = "0.8.4"$/version = "0.9.0"/}' /src/proofmode/Cargo.lock \
    && cargo build --manifest-path /src/proofmode/Cargo.toml --release --locked --bin proofmode \
    && cp /src/proofmode/target/release/proofmode /out/bin/ \
    && strip /out/bin/c2patool /out/bin/proofmode

# Debian (glibc) base: the Matrix Rust crypto module ships glibc binaries.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# ca-certificates for TLS to the homeserver and Tinfoil.
# exiftool reads photo/video/audio metadata for inspect_media (Perl, ~30 MB).
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
       libimage-exiftool-perl \
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

# c2patool and proofmode (built above). Their C2PA trust lists are in c2pa-trust/.
COPY --from=forensics-tools /out/bin/c2patool /out/bin/proofmode /usr/local/bin/

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY prompts ./prompts
COPY c2pa-trust ./c2pa-trust

# Runtime state (sync token, crypto store, cached login) lives here. In a Tinfoil
# Container this is a tmpfs, so it is wiped on restart.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV HEALTH_PORT=8080
EXPOSE 8080

# Settings come from the environment (tinfoil-config.yml env + secrets), not .env.
CMD ["node", "src/index.js"]
