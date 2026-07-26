FROM node:24.1.0-alpine3.20

ARG OPEN_KRITT_ENABLE_CODEX=
ARG CODEX_API_KEY_CONFIGURED=
ARG CODEX_LOGIN_CONFIGURED=

WORKDIR /app

# Install deps + generate the Prisma client at build time. (The compose file also
# bind-mounts the source for live editing, with an anonymous volume keeping
# node_modules, so deps are installed again on first start to be safe.)
COPY package*.json ./
RUN npm install
RUN npm install --global --no-audit --no-fund @openai/codex@0.144.6 \
    && npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.215
COPY . .
RUN npx prisma generate

EXPOSE 3002

# On start: ensure the mounted project-config directory contains a real .env
# file, then ensure deps + client are present, apply the schema idempotently,
# and launch.
CMD ["sh", "./docker-entrypoint.sh"]
