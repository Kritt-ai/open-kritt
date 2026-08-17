#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-"$ROOT_DIR/.env"}"
SQL_FILE="$ROOT_DIR/database/init/001_create_pattern_tables.sql"

read_env_value() {
    local key="$1"
    local file="$2"
    local line value

    line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
    if [[ -z "$line" ]]; then
        return 0
    fi

    value="${line#*=}"
    value="${value%$'\r'}"

    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
        value="${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
    fi

    printf '%s' "$value"
}

DB_URL="${DATABASE_URL:-}"

if [[ -z "$DB_URL" && -f "$ENV_FILE" ]]; then
    DB_URL="$(read_env_value DATABASE_URL "$ENV_FILE")"
fi

if [[ -z "$DB_URL" ]]; then
    echo "Set DATABASE_URL, or provide ENV_FILE pointing to a .env file that defines DATABASE_URL." >&2
    exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required to create the pattern tables." >&2
    exit 1
fi

psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"
