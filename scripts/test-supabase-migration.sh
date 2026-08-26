#!/usr/bin/env bash
set -euo pipefail

schema="supabase/migrations/20260826223000_initial_schema.sql"
import="scripts/import-supabase-dump.sh"

for table in GuildConfig BotRuntime VoiceEvent MusicHistory; do
  grep -q "CREATE TABLE.*\\\"${table}\\\"" "$schema"
done
grep -q 'ENABLE ROW LEVEL SECURITY' "$schema"
grep -q 'VoiceEvent_guildId_createdAt_idx' "$schema"
grep -q 'MusicHistory_guildId_createdAt_idx' "$schema"
! grep -q 'Poe2Watch' "$schema"
! "$import" 2>/dev/null
