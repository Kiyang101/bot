import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260829010000_soundboard_durable_recovery_fixes.sql', import.meta.url),
  'utf8',
);

test('recovery migration persists replay intent and bounded consumer state', () => {
  for (const column of [
    'generatedStoragePath',
    'sourceDurationSec',
    'generatedDurationSec',
    'trimStartMs',
    'trimEndMs',
    'sourceMimeType',
    'generatedMimeType',
    'sourceSizeBytes',
    'generatedSizeBytes',
    'attempts',
    'nextAttemptAt',
  ]) {
    const columnPattern = column === 'attempts'
      ? 'ADD COLUMN IF NOT EXISTS attempts'
      : `ADD COLUMN IF NOT EXISTS "${column}"`;
    assert.match(migration, new RegExp(columnPattern));
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_sound_mutation_recovery/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.defer_sound_mutation_recovery/);
  assert.match(migration, /manual_required/);
});

test('recovery RPCs bind sound, token, operation, version, lease, and legal transitions', () => {
  assert.match(migration, /p_operation text/);
  assert.match(migration, /lease\.operation = p_operation/);
  assert.match(migration, /recovery\.operation = p_operation/);
  assert.match(migration, /lease\."expiresAt" > CURRENT_TIMESTAMP/);
  assert.match(migration, /recovery\."expectedVersion" = p_expected_version/);
  assert.match(migration, /state = 'delete_restored'/);
  assert.match(migration, /trim_abandoned/);
});

test('commit and cleanup contracts keep storage paths server-side and owner-derived', () => {
  assert.match(migration, /generatedStoragePath.*sounds\//s);
  assert.match(migration, /p_generated_path.*expected_generated_path/s);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_sound_mutation_recovery/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_sound_mutation_recovery.*service_role/);
});
