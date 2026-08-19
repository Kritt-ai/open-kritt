FROM docker:27-cli AS docker-cli

FROM node:24.15.0-bookworm-slim AS node_runtime

FROM python:3.12.7-slim-bookworm

WORKDIR /app

# Copy the Node runtime as a tree so the npm/npx symlinks retain their targets.
COPY --from=node_runtime /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git util-linux \
    && npm install --global --no-audit --no-fund npm@12.0.1 \
    && npm install --global --no-audit --no-fund @openai/codex@0.145.0 \
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
    && ln -s /run/open-kritt-secrets/codex-home-source /codex-home-source \
    && ln -s /run/open-kritt-secrets/local-repos /local_repos

# Tool-enabled scans run as root inside disposable per-job containers. Keep
# Cursor in a shared, checksummed image path so every runner can invoke it.
ARG TARGETARCH
ARG CURSOR_AGENT_VERSION=2026.07.09-a3815c0
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
    && rm /tmp/cursor-agent.tar.gz

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
