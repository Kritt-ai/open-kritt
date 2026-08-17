#!/bin/sh
set -eu

if [ -n "${OPEN_KRITT_ENV_FILE_PATH:-}" ]; then
  env_dir=$(dirname "$OPEN_KRITT_ENV_FILE_PATH")
  mkdir -p "$env_dir"
  if [ ! -e "$OPEN_KRITT_ENV_FILE_PATH" ]; then
    : > "$OPEN_KRITT_ENV_FILE_PATH"
    chmod 600 "$OPEN_KRITT_ENV_FILE_PATH" 2>/dev/null || true
  fi
fi

npm install
npx prisma generate
npm run migrate
exec node src/server.js
