import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260829010000_soundboard_durable_recovery_fixes.sql', import.meta.url),
  'utf8',
);
const soundsSource = readFileSync(
  new URL('../dashboard/lib/sounds.ts', import.meta.url),
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

test('upload cleanup intent is durable before Storage work and remains server-only', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\."SoundUploadRecovery"/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prepare_sound_upload_recovery/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mark_sound_upload_recovery_pending/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_sound_upload_recovery/);
  assert.match(migration, /sourceStoragePath/);
  assert.match(migration, /playableStoragePath/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.prepare_sound_upload_recovery/);
});

test('delete recovery persists the source MIME and restoration reads that intent', () => {
  const deleteFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.prepare_sound_delete_mutation[\s\S]*?\n\$\$;/,
  )?.[0] ?? '';
  assert.match(deleteFunction, /"sourceMimeType"/);
  assert.match(deleteFunction, /sound\."mimeType"/);
  assert.match(soundsSource, /sourceMimeType: recovery\.sourceMimeType/);
  assert.doesNotMatch(soundsSource, /sourceMimeType: recovery\.sourceMimeType \?\? 'audio\/wav'/);
});

test('delete preparation derives staging paths from the authoritative Sound row and stage id', () => {
  const deleteFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.prepare_sound_delete_mutation[\s\S]*?\n\$\$;/,
  )?.[0] ?? '';
  assert.match(deleteFunction, /p_stage_id uuid/);
  assert.match(deleteFunction, /'sounds\/' \|\| owner_id \|\| '\/' \|\| p_sound_id::text \|\| '\/staging\/' \|\| p_stage_id/);
  assert.doesNotMatch(deleteFunction, /p_staged_source_path/);
  assert.doesNotMatch(deleteFunction, /p_staged_playable_path/);
  assert.doesNotMatch(deleteFunction, /p_source_path text/);
});

test('trim keeps the five-argument compatibility overload alongside complete intent', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prepare_sound_trim_mutation\(\n  p_sound_id uuid,\n  p_token uuid,\n  p_expected_version bigint,\n  p_version_id uuid,\n  p_previous_playable_path text\n\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prepare_sound_trim_mutation\(\n  p_sound_id uuid,\n  p_token uuid,\n  p_expected_version bigint,\n  p_version_id uuid,\n  p_source_path text,/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.prepare_sound_trim_mutation\(uuid, uuid, bigint, uuid, text\)/);
});
