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
ARG GROK_BUILD_VERSION=1.0.0
RUN apk add --no-cache curl ca-certificates \
    && case "${TARGETARCH}" in \
      amd64) grok_arch=linux-x86_64; grok_sha256=28dbc967a5843dae2374b6834dadbab95354e685c7e5c8dc750b92a4e5fc7c3e ;; \
      arm64) grok_arch=linux-aarch64; grok_sha256=bb7c51116564a2219f6a49850815060f416918ac407f1f2ba82c53c0b0d4383f ;; \
      *) echo "unsupported Grok Build architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://x.ai/cli/grok-${GROK_BUILD_VERSION}-${grok_arch}" -o /tmp/grok \
    && echo "${grok_sha256}  /tmp/grok" | sha256sum -c - \
    && install -m 0755 /tmp/grok /usr/local/bin/grok \
    && rm /tmp/grok \
    && grok --version
COPY . .
RUN npx prisma generate

EXPOSE 3002

# On start: ensure deps + client are present (handles the mounted-volume case),
# apply the schema idempotently (covers a persisted-but-empty DB), then launch.
CMD ["sh", "-c", "npm install && npx prisma generate && npm run migrate && node src/server.js"]
