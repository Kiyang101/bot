import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isUploadRecoveryCandidate, resolveUploadRecovery } from '../dashboard/lib/sound-recovery';

const migration = readFileSync(
  new URL('../supabase/migrations/20260829010000_soundboard_durable_recovery_fixes.sql', import.meta.url),
  'utf8',
);
const soundsSource = readFileSync(
  new URL('../dashboard/lib/sounds.ts', import.meta.url),
  'utf8',
);
const instrumentationSource = readFileSync(
  new URL('../dashboard/instrumentation.ts', import.meta.url),
  'utf8',
);
const recoveryWorkerSource = readFileSync(
  new URL('../dashboard/lib/sound-recovery-worker.ts', import.meta.url),
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
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prepare_sound_upload_recovery_tokenized/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mark_sound_upload_recovery_pending_tokenized/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_sound_upload_recovery_tokenized/);
  assert.match(migration, /sourceStoragePath/);
  assert.match(migration, /playableStoragePath/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.prepare_sound_upload_recovery\(uuid, text, text, text\) FROM PUBLIC/);
});

test('legacy upload RPC signatures remain available beside tokenized contracts', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.prepare_sound_upload_recovery\(\n  p_sound_id uuid,\n  p_uploaded_by_id text,\n  p_source_path text,\n  p_playable_path text\n\)\nRETURNS boolean/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mark_sound_upload_recovery_pending\(\n  p_sound_id uuid,\n  p_last_error text\n\)\nRETURNS boolean/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_sound_upload_recovery\(\n  p_sound_id uuid\n\)\nRETURNS boolean/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mark_sound_upload_recovery_pending\(uuid, text\) FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.complete_sound_upload_recovery\(uuid\) FROM PUBLIC/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.(?:prepare_sound_upload_recovery|mark_sound_upload_recovery_pending|complete_sound_upload_recovery)/);
  assert.match(soundsSource, /prepare_sound_upload_recovery_tokenized/);
  assert.match(soundsSource, /mark_sound_upload_recovery_pending_tokenized/);
  assert.match(soundsSource, /complete_sound_upload_recovery_tokenized/);
});

test('durable recovery has an actual startup and scheduled consumer for both queues', () => {
  assert.match(instrumentationSource, /export async function register\(\)/);
  assert.match(instrumentationSource, /process\.env\.NEXT_RUNTIME !== 'nodejs'/);
  assert.match(instrumentationSource, /setInterval/);
  assert.match(instrumentationSource, /runSoundRecoveryWorker/);
  assert.match(recoveryWorkerSource, /reconcileSoundMutationRecoveries/);
  assert.match(recoveryWorkerSource, /reconcileSoundCleanupTasks/);
  assert.match(recoveryWorkerSource, /inFlight/);
});

test('cleanup queue has bounded retries with explicit manual escalation', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending'/);
  assert.match(migration, /state IN \('pending', 'manual_required'\)/);
  assert.match(migration, /state = CASE WHEN .*manual_required/);
  assert.match(soundsSource, /MAX_SOUND_CLEANUP_ATTEMPTS/);
  assert.match(soundsSource, /reconcileSoundCleanupTasks/);
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

test('legacy trim preparation accepts a valid lease and rejects stale or mismatched callers', () => {
  const legacyFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.prepare_sound_trim_mutation\(\n  p_sound_id uuid,\n  p_token uuid,\n  p_expected_version bigint,\n  p_version_id uuid,\n  p_previous_playable_path text\n\)[\s\S]*?\n\$\$;/,
  )?.[0] ?? '';
  assert.match(legacyFunction, /RETURN true/);
  assert.match(legacyFunction, /lease\.token = p_token/);
  assert.match(legacyFunction, /sound\."storagePath" = p_previous_playable_path/);
  assert.doesNotMatch(legacyFunction, /RETURN false;\n  END IF;\n  RETURN false;/);
});

test('upload recovery has active lease, atomic claim, and cleanup-bound terminal contracts', () => {
  assert.match(migration, /"leaseToken" uuid/);
  assert.match(migration, /"leaseExpiresAt" timestamp with time zone/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.heartbeat_sound_upload_recovery/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_sound_upload_recovery/);
  assert.match(migration, /state = 'uploading'[\s\S]*leaseExpiresAt.*CURRENT_TIMESTAMP/);
  assert.match(migration, /p_source_absent boolean/);
  assert.match(migration, /p_playable_absent boolean/);
  assert.match(migration, /p_outcome text/);
  assert.match(migration, /p_source_path <> recovery\."sourceStoragePath"/);
  assert.match(migration, /p_playable_path <> recovery\."playableStoragePath"/);
  assert.match(migration, /recovery\.state (?:<>|=) 'cleanup_pending'/);
  assert.match(migration, /recovery\."claimToken" IS NOT NULL[\s\S]*recovery\."claimExpiresAt" > CURRENT_TIMESTAMP/);
});

test('upload recovery helper preserves active intent until both objects are absent', () => {
  const now = Date.parse('2026-08-29T00:00:00.000Z');
  assert.equal(isUploadRecoveryCandidate({
    state: 'uploading',
    nextAttemptAt: '2026-08-28T23:59:00.000Z',
    leaseExpiresAt: '2026-08-29T00:05:00.000Z',
  }, now), false);
  assert.equal(isUploadRecoveryCandidate({
    state: 'uploading',
    nextAttemptAt: '2026-08-28T23:59:00.000Z',
    leaseExpiresAt: '2026-08-28T23:59:00.000Z',
  }, now), true);
  assert.equal(resolveUploadRecovery({
    hasSoundRow: false, soundPathsMatch: false, sourceAbsent: true, playableAbsent: false,
  }), 'defer');
  assert.equal(resolveUploadRecovery({
    hasSoundRow: false, soundPathsMatch: false, sourceAbsent: true, playableAbsent: true,
  }), 'objects_absent');
  assert.equal(resolveUploadRecovery({
    hasSoundRow: true, soundPathsMatch: true, sourceAbsent: false, playableAbsent: false,
  }), 'row_committed');
});
