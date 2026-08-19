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
COPY . .
RUN npx prisma generate

EXPOSE 3002

# On start: ensure deps + client are present (handles the mounted-volume case),
# apply the schema idempotently (covers a persisted-but-empty DB), then launch.
CMD ["sh", "-c", "npm install && npx prisma generate && npm run migrate && node src/server.js"]
