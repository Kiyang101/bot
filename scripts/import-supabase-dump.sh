#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 /path/to/postgres.dump [supabase-db-url]" >&2
  echo "       SUPABASE_DB_URL=... $0 /path/to/postgres.dump" >&2
}

DUMP_PATH="${1:-}"
TARGET_URL="${2:-${SUPABASE_DB_URL:-}}"

if [[ -z "$DUMP_PATH" || ! -f "$DUMP_PATH" || -z "$TARGET_URL" ]]; then
  usage
  exit 2
fi

if ! command -v pg_restore >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "PostgreSQL pg_restore and psql are required." >&2
  exit 2
fi

restore_version="$(pg_restore --version)"
restore_major="$(sed -nE 's/.*PostgreSQL[^0-9]*([0-9]+)\..*/\1/p' <<<"$restore_version")"
if [[ ! "$restore_major" =~ ^[0-9]+$ || "$restore_major" -lt 17 ]]; then
  echo "PostgreSQL 17 or newer pg_restore is required; found: $restore_version" >&2
  exit 2
fi

echo "Importing GuildConfig, BotRuntime, VoiceEvent, and MusicHistory from $DUMP_PATH"
echo "Poe2Watch and _prisma_migrations are intentionally excluded."

pg_restore \
  --exit-on-error \
  --data-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --dbname="$TARGET_URL" \
  --table='BotRuntime' \
  --table='GuildConfig' \
  --table='MusicHistory' \
  --table='VoiceEvent' \
  "$DUMP_PATH"

psql "$TARGET_URL" --set ON_ERROR_STOP=1 <<'SQL'
SELECT setval(
  pg_get_serial_sequence('public."VoiceEvent"', 'id'),
  COALESCE(MAX(id), 1),
  MAX(id) IS NOT NULL
)
FROM public."VoiceEvent";

SELECT setval(
  pg_get_serial_sequence('public."MusicHistory"', 'id'),
  COALESCE(MAX(id), 1),
  MAX(id) IS NOT NULL
)
FROM public."MusicHistory";
SQL

echo "Supabase data import complete."
