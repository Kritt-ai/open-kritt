FROM node:24.1.0-alpine3.20

WORKDIR /app

# Install deps + generate the Prisma client at build time. (The compose file also
# bind-mounts the source for live editing, with an anonymous volume keeping
# node_modules, so deps are installed again on first start to be safe.)
COPY package*.json ./
RUN npm install
RUN npm install --global --no-audit --no-fund @openai/codex@0.145.0 \
    && codex --version \
    && npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.215
# Accounts spawns `grok login --device-auth` inside this image. Pin the same
# Grok Build CLI version as the engine (linux musl/glibc: Alpine uses musl, so
# prefer the official static linux binary).
ARG TARGETARCH
ARG GROK_BUILD_VERSION=1.0.5
RUN apk add --no-cache curl ca-certificates \
    && case "${TARGETARCH}" in \
      amd64) grok_arch=linux-x86_64; grok_sha256=9ba87444e1819e8f6104adbbf4676a870c204380aa5c3e1c38a926c4ea677238 ;; \
      arm64) grok_arch=linux-aarch64; grok_sha256=1c1fe67d7c35497fb09f44a451f57acc3787add4c9aea2c56f5c7c75dc5ffcf1 ;; \
      *) echo "unsupported Grok Build architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://x.ai/cli/grok-${GROK_BUILD_VERSION}-${grok_arch}" -o /tmp/grok \
    && echo "${grok_sha256}  /tmp/grok" | sha256sum -c - \
    && install -m 0755 /tmp/grok /usr/local/bin/grok \
    && rm /tmp/grok \
    && grok --version
# Accounts spawns `devin auth login` inside this image. Pin the same Devin CLI
# version as the engine; the published binary is statically linked so the same
# tarball serves glibc and musl hosts.
ARG DEVIN_CLI_VERSION=3000.11.3
RUN case "${TARGETARCH}" in \
      amd64) devin_arch=x86_64-unknown-linux; devin_sha256=83b3b113c01bf2a3e9e100db08d77e6b086806a7754f091e20831bdfe215157e ;; \
      arm64) devin_arch=aarch64-unknown-linux; devin_sha256=21a2d7a8dea67987067cde7eb3fe7193a48daa8f8c3d50d414c603c4a2b67f15 ;; \
      *) echo "unsupported Devin CLI architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/devin-${DEVIN_CLI_VERSION}-${devin_arch}.tar.gz" -o /tmp/devin.tar.gz \
    && echo "${devin_sha256}  /tmp/devin.tar.gz" | sha256sum -c - \
    && mkdir -p "/opt/devin/versions/${DEVIN_CLI_VERSION}" \
    && tar -xzf /tmp/devin.tar.gz -C "/opt/devin/versions/${DEVIN_CLI_VERSION}" \
    && ln -s "/opt/devin/versions/${DEVIN_CLI_VERSION}/bin/devin" /usr/local/bin/devin \
    && rm /tmp/devin.tar.gz \
    && devin --version
COPY . .
RUN npx prisma generate

EXPOSE 3002

# On start: ensure deps + client are present (handles the mounted-volume case),
# apply the schema idempotently (covers a persisted-but-empty DB), then launch.
CMD ["sh", "-c", "npm install && npx prisma generate && npm run migrate && node src/server.js"]
