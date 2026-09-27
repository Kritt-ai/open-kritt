FROM docker:29.8.0-cli AS docker-cli

FROM node:24.15.0-bookworm-slim AS node_runtime

FROM python:3.12.14-slim-bookworm

WORKDIR /app

# Copy the Node runtime as a tree so the npm/npx symlinks retain their targets.
COPY --from=node_runtime /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git poppler-utils util-linux \
    && npm install --global --no-audit --no-fund npm@12.0.1 \
    && npm install --global --no-audit --no-fund @openai/codex@0.157.1 \
    && codex --version \
    && npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.215 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Keep sensitive bind mounts below one root-only traversal boundary. The legacy
# paths remain root-visible symlinks for runtime config and existing installs.
RUN mkdir -p /run/open-kritt-secrets \
    && chmod 0700 /run/open-kritt-secrets \
    && ln -s /run/open-kritt-secrets/credentials /credentials \
    && ln -s /run/open-kritt-secrets/codex-accounts /codex-accounts \
    && ln -s /run/open-kritt-secrets/claude-accounts /claude-accounts \
    && ln -s /run/open-kritt-secrets/grok-accounts /grok-accounts \
    && ln -s /run/open-kritt-secrets/codex-home-source /codex-home-source \
    && ln -s /run/open-kritt-secrets/local-repos /local_repos

# Tool-enabled scans run as root inside disposable per-job containers. Keep
# Cursor and Grok Build in shared, checksummed image paths so every runner can
# invoke them.
ARG TARGETARCH
ARG CURSOR_AGENT_VERSION=2026.07.09-a3815c0
ARG GROK_BUILD_VERSION=1.0.5
RUN case "${TARGETARCH}" in \
      amd64) cursor_arch=x64; cursor_sha256=c7c1f32249cedb99cc20cd4eed1f9308dc2299a78c283bbc6efd6d658cd4977e ;; \
      arm64) cursor_arch=arm64; cursor_sha256=11b2b6801136a11a3632a4b1080ea3bfc7d97d0a68382be9ede1faf5333207fb ;; \
      *) echo "unsupported Cursor Agent architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz" -o /tmp/cursor-agent.tar.gz \
    && echo "${cursor_sha256}  /tmp/cursor-agent.tar.gz" | sha256sum -c - \
    && mkdir -p "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}" \
    && tar --strip-components=1 -xzf /tmp/cursor-agent.tar.gz -C "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}" \
    && ln -s "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}/cursor-agent" /usr/local/bin/agent \
    && ln -s "/opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}/cursor-agent" /usr/local/bin/cursor-agent \
    && rm /tmp/cursor-agent.tar.gz \
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

# Foundry lets verification stages compile and run Solidity PoCs (forge test,
# local anvil forks) inside the disposable runner containers.
ARG FOUNDRY_VERSION=v1.8.3
RUN case "${TARGETARCH}" in \
      amd64) foundry_sha256=7ca48e6ca3cac1bce1403ca67e5bc1dc3bc1fd818199c9957c7165079c228568 ;; \
      arm64) foundry_sha256=93fc23be26c8a902ca58fe54aa6ca28c880b58af95d052674933161df7928e6d ;; \
      *) echo "unsupported Foundry architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/foundry.tar.gz \
    && echo "${foundry_sha256}  /tmp/foundry.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin forge cast anvil \
    && rm /tmp/foundry.tar.gz \
    && forge --version \
    && anvil --version

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV ENGINE_DATA_DIR=/data \
    ENGINE_CHECKOUT_CACHE_DIR=/checkout-cache \
    ENGINE_WORKER_COUNT=25 \
    CODEX_HOME=/root/.codex \
    PATH="/root/.local/bin:${PATH}"

CMD ["python", "-m", "open_kritt_engine"]
