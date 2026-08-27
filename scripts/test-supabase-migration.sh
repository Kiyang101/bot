#!/usr/bin/env bash
set -euo pipefail

schema="supabase/migrations/20260826223000_initial_schema.sql"
auth_schema="supabase/migrations/20260827090000_dashboard_users.sql"
import="scripts/import-supabase-dump.sh"

for table in GuildConfig BotRuntime VoiceEvent MusicHistory; do
  grep -q "CREATE TABLE.*\\\"${table}\\\"" "$schema"
done
grep -q 'ENABLE ROW LEVEL SECURITY' "$schema"
grep -q 'VoiceEvent_guildId_createdAt_idx' "$schema"
grep -q 'MusicHistory_guildId_createdAt_idx' "$schema"
! grep -q 'Poe2Watch' "$schema"
grep -q 'CREATE TYPE public."DashboardRole"' "$auth_schema"
grep -q 'CREATE TABLE public."DashboardUser"' "$auth_schema"
grep -q 'ENABLE ROW LEVEL SECURITY' "$auth_schema"
grep -q 'users can read their own dashboard account' "$auth_schema"
! "$import" 2>/dev/null

fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "${1:-}" == "--version" ]]; then' \
  '  echo "pg_restore (PostgreSQL) 17.11 (Homebrew)"' \
  'fi' \
  'exit 0' > "$fixture_dir/pg_restore"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exit 0' > "$fixture_dir/psql"
chmod +x "$fixture_dir/pg_restore" "$fixture_dir/psql"
touch "$fixture_dir/source.dump"

PATH="$fixture_dir:$PATH" SUPABASE_DB_URL='postgresql://test' \
  "$import" "$fixture_dir/source.dump" >/dev/null
