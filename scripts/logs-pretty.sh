#!/usr/bin/env sh
# Pretty-print backend logs without changing the running container configuration.
exec docker compose logs -f --no-log-prefix backend | npx --yes pino-pretty --colorize
