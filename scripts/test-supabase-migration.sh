#!/usr/bin/env bash
set -euo pipefail

schema="supabase/migrations/20260826223000_initial_schema.sql"
auth_schema="supabase/migrations/20260827090000_dashboard_users.sql"
soundboard_schema="supabase/migrations/20260827210000_soundboard.sql"
durable_soundboard_schema="supabase/migrations/20260828230000_soundboard_durable_mutations.sql"
durable_recovery_schema="supabase/migrations/20260829000000_soundboard_recovery_ledger.sql"
durable_recovery_fixes_schema="supabase/migrations/20260829010000_soundboard_durable_recovery_fixes.sql"
import="scripts/import-supabase-dump.sh"

for table in GuildConfig BotRuntime VoiceEvent MusicHistory; do
  grep -q "CREATE TABLE.*\\\"${table}\\\"" "$schema"
done
grep -q 'ENABLE ROW LEVEL SECURITY' "$schema"
grep -q 'VoiceEvent_guildId_createdAt_idx' "$schema"
grep -q 'MusicHistory_guildId_createdAt_idx' "$schema"
! grep -q 'Poe2Watch' "$schema"
grep -q 'CREATE TABLE public."Sound"' "$soundboard_schema"
grep -q 'ALTER TABLE public."Sound"' "$durable_soundboard_schema"
grep -q 'ADD COLUMN IF NOT EXISTS "mutationVersion"' "$durable_soundboard_schema"
grep -q 'CREATE TABLE IF NOT EXISTS public."SoundMutationLease"' "$durable_soundboard_schema"
grep -q 'CREATE TABLE IF NOT EXISTS public."SoundCleanupTask"' "$durable_soundboard_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.acquire_sound_mutation' "$durable_soundboard_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.commit_sound_trim' "$durable_soundboard_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.delete_sound_row_if_mutation' "$durable_soundboard_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.enqueue_sound_cleanup' "$durable_soundboard_schema"
grep -q 'CREATE TABLE IF NOT EXISTS public."SoundMutationRecovery"' "$durable_recovery_schema"
grep -q 'prepare_sound_trim_mutation' "$durable_recovery_schema"
grep -q 'prepare_sound_delete_mutation' "$durable_recovery_schema"
grep -q "lease.operation = 'trim'" "$durable_recovery_schema"
grep -q "lease.operation = 'delete'" "$durable_recovery_schema"
grep -q 'restore_pending' "$durable_recovery_schema"
grep -q 'generatedStoragePath' "$durable_recovery_fixes_schema"
grep -q 'sourceDurationSec' "$durable_recovery_fixes_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.claim_sound_mutation_recovery' "$durable_recovery_fixes_schema"
grep -q 'CREATE OR REPLACE FUNCTION public.defer_sound_mutation_recovery' "$durable_recovery_fixes_schema"
grep -q 'manual_required' "$durable_recovery_fixes_schema"
trim_cas_fn="$(awk '/CREATE OR REPLACE FUNCTION public.commit_sound_trim/{in_fn=1} in_fn{print} /^\$\$;/{if(in_fn){exit}}' "$durable_recovery_schema")"
delete_cas_fn="$(awk '/CREATE OR REPLACE FUNCTION public.delete_sound_row_if_mutation/{in_fn=1} in_fn{print} /^\$\$;/{if(in_fn){exit}}' "$durable_recovery_schema")"
grep -q "lease.operation = 'trim'" <<<"$trim_cas_fn"
grep -q "lease.operation = 'delete'" <<<"$delete_cas_fn"
! grep -q "lease.operation = 'delete'" <<<"$trim_cas_fn"
! grep -q "lease.operation = 'trim'" <<<"$delete_cas_fn"
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
