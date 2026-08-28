-- Durable recovery hardening for Storage-backed Sound mutations.
--
-- This migration is append-only with respect to the existing ledger. It adds
-- replay intent, a bounded recovery consumer lease, and explicit terminal
-- states so an expired worker cannot strand a sound forever.

ALTER TABLE public."SoundMutationRecovery"
  ADD COLUMN IF NOT EXISTS "versionId" uuid,
  ADD COLUMN IF NOT EXISTS "generatedStoragePath" text,
  ADD COLUMN IF NOT EXISTS "trimStartMs" integer,
  ADD COLUMN IF NOT EXISTS "trimEndMs" integer,
  ADD COLUMN IF NOT EXISTS "sourceDurationSec" numeric,
  ADD COLUMN IF NOT EXISTS "generatedDurationSec" numeric,
  ADD COLUMN IF NOT EXISTS "sourceMimeType" text,
  ADD COLUMN IF NOT EXISTS "generatedMimeType" text,
  ADD COLUMN IF NOT EXISTS "sourceSizeBytes" bigint,
  ADD COLUMN IF NOT EXISTS "generatedSizeBytes" bigint,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE public."SoundMutationRecovery"
SET "generatedStoragePath" = COALESCE("generatedStoragePath", "stagedPlayablePath")
WHERE operation = 'trim';

UPDATE public."SoundMutationRecovery"
SET state = 'manual_required',
    "lastError" = 'Recovery record predates the durable trim replay contract.'
WHERE operation = 'trim' AND "versionId" IS NULL
  AND state IN ('trim_uploading', 'trim_uploaded');

UPDATE public."SoundMutationRecovery"
SET state = 'manual_required',
    "lastError" = 'Recovery record has no sound binding.'
WHERE "soundId" IS NULL
  AND state NOT IN ('trim_committed', 'trim_abandoned', 'delete_committed', 'delete_restored', 'manual_required');

-- Delete recovery must outlive the Sound row until staged objects are
-- discarded. The recovery token and lease remain the authorization boundary.
ALTER TABLE public."SoundMutationLease"
  DROP CONSTRAINT IF EXISTS "SoundMutationLease_soundId_fkey";

ALTER TABLE public."SoundMutationRecovery"
  DROP CONSTRAINT IF EXISTS "SoundMutationRecovery_state_check",
  DROP CONSTRAINT IF EXISTS "SoundMutationRecovery_replay_intent_check",
  ADD CONSTRAINT "SoundMutationRecovery_state_check" CHECK (state IN (
    'trim_uploading', 'trim_uploaded', 'trim_committed', 'trim_abandoned',
    'delete_staging', 'delete_ready', 'delete_objects_removed',
    'delete_committed', 'delete_restored', 'restore_pending', 'manual_required'
  )),
  ADD CONSTRAINT "SoundMutationRecovery_replay_intent_check" CHECK (
    (operation <> 'trim') OR state IN ('trim_committed', 'trim_abandoned', 'manual_required') OR (
      "versionId" IS NOT NULL
      AND "sourceStoragePath" IS NOT NULL
      AND "generatedStoragePath" IS NOT NULL
      AND "trimStartMs" IS NOT NULL
      AND "trimEndMs" IS NOT NULL
      AND "sourceDurationSec" IS NOT NULL
      AND "generatedDurationSec" IS NOT NULL
      AND "sourceMimeType" IS NOT NULL
      AND "generatedMimeType" IS NOT NULL
      AND "sourceSizeBytes" IS NOT NULL
      AND "generatedSizeBytes" IS NOT NULL
    )
  );

ALTER TABLE public."SoundMutationRecovery"
  DROP CONSTRAINT IF EXISTS "SoundMutationRecovery_paths_contract",
  ADD CONSTRAINT "SoundMutationRecovery_paths_contract" CHECK (
    ("sourceStoragePath" IS NULL OR "sourceStoragePath" ~ '^sounds/[^/]+/[^/]+/source$')
    AND ("playableStoragePath" IS NULL OR "playableStoragePath" ~ '^sounds/[^/]+/[^/]+/playable(-[^/]+)?$')
    AND ("generatedStoragePath" IS NULL OR "generatedStoragePath" ~ '^sounds/[^/]+/[^/]+/playable-[^/]+$')
    AND ("stagedSourcePath" IS NULL OR "stagedSourcePath" ~ '^sounds/[^/]+/[^/]+/staging/[^/]+/source$')
    AND ("stagedPlayablePath" IS NULL OR "stagedPlayablePath" ~ '^sounds/[^/]+/[^/]+/(playable-[^/]+|staging/[^/]+/playable)$')
  ),
  ADD CONSTRAINT "SoundMutationRecovery_replay_values_check" CHECK (
    (operation <> 'trim') OR state IN ('trim_committed', 'trim_abandoned', 'manual_required') OR (
      "trimStartMs" >= 0
      AND "trimEndMs" > "trimStartMs"
      AND "trimEndMs" - "trimStartMs" >= 100
      AND "sourceDurationSec" >= 0
      AND "generatedDurationSec" > 0
      AND "sourceSizeBytes" >= 0
      AND "generatedSizeBytes" > 44
      AND "sourceMimeType" IN ('audio/mpeg', 'audio/wav', 'audio/ogg')
      AND "generatedMimeType" = 'audio/wav'
    )
  );

DROP INDEX IF EXISTS "SoundMutationRecovery_active_sound_key";
CREATE UNIQUE INDEX "SoundMutationRecovery_active_sound_key"
  ON public."SoundMutationRecovery" ("soundId")
  WHERE "soundId" IS NOT NULL AND state IN (
    'trim_uploading', 'trim_uploaded', 'delete_staging',
    'delete_ready', 'delete_objects_removed', 'restore_pending'
  );

CREATE INDEX IF NOT EXISTS "SoundMutationRecovery_due_idx"
  ON public."SoundMutationRecovery" ("nextAttemptAt", "updatedAt");

-- A safe expired trim/staging record can be retired to manual_required so a
-- later user mutation is not blocked forever. Destructive post-delete states
-- remain blocked until the recovery consumer restores or completes them.
CREATE OR REPLACE FUNCTION public.acquire_sound_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_operation text,
  p_lease_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  current_version bigint;
  current_expiry timestamp with time zone;
BEGIN
  IF p_operation NOT IN ('trim', 'delete') OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid sound mutation lease request.';
  END IF;

  SELECT "mutationVersion" INTO current_version
  FROM public."Sound"
  WHERE id = p_sound_id
  FOR UPDATE;
  IF current_version IS NULL THEN
    RETURN jsonb_build_object('acquired', false);
  END IF;

  SELECT "expiresAt" INTO current_expiry
  FROM public."SoundMutationLease"
  WHERE "soundId" = p_sound_id
  FOR UPDATE;
  IF current_expiry IS NOT NULL AND current_expiry > CURRENT_TIMESTAMP THEN
    RETURN jsonb_build_object('acquired', false, 'mutation_version', current_version);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."SoundMutationRecovery"
    WHERE "soundId" = p_sound_id
      AND state IN ('delete_objects_removed', 'restore_pending')
  ) THEN
    RETURN jsonb_build_object('acquired', false, 'mutation_version', current_version);
  END IF;

  UPDATE public."SoundMutationRecovery"
  SET state = 'manual_required',
      "lastError" = 'Recovery lease expired; retained objects require reconciliation.',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id
    AND state IN ('trim_uploading', 'trim_uploaded', 'delete_staging', 'delete_ready');

  INSERT INTO public."SoundMutationLease" ("soundId", token, operation, "expiresAt")
  VALUES (p_sound_id, p_token, p_operation, CURRENT_TIMESTAMP + make_interval(secs => p_lease_seconds))
  ON CONFLICT ("soundId") DO UPDATE
  SET token = EXCLUDED.token,
      operation = EXCLUDED.operation,
      "expiresAt" = EXCLUDED."expiresAt",
      "createdAt" = CURRENT_TIMESTAMP;

  RETURN jsonb_build_object('acquired', true, 'mutation_version', current_version);
END;
$$;

DROP FUNCTION IF EXISTS public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text);
CREATE OR REPLACE FUNCTION public.prepare_sound_trim_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_version_id uuid,
  p_source_path text,
  p_generated_path text,
  p_trim_start_ms integer,
  p_trim_end_ms integer,
  p_source_duration_sec numeric,
  p_generated_duration_sec numeric,
  p_source_mime_type text,
  p_generated_mime_type text,
  p_source_size_bytes bigint,
  p_generated_size_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  owner_id text;
  expected_generated_path text;
BEGIN
  SELECT "uploadedById" INTO owner_id
  FROM public."Sound" AS sound
  JOIN public."SoundMutationLease" AS lease ON lease."soundId" = sound.id
  WHERE sound.id = p_sound_id
    AND lease.token = p_token
    AND lease.operation = 'trim'
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND sound."mutationVersion" = p_expected_version
    AND sound."sourceStoragePath" = p_source_path;

  IF owner_id IS NULL
     OR p_trim_start_ms < 0
     OR p_trim_end_ms <= p_trim_start_ms
     OR p_trim_end_ms - p_trim_start_ms < 100
     OR p_source_duration_sec < 0
     OR p_generated_duration_sec <= 0
     OR p_source_size_bytes < 0
     OR p_generated_size_bytes <= 44
     OR p_source_mime_type NOT IN ('audio/mpeg', 'audio/wav', 'audio/ogg')
     OR p_generated_mime_type <> 'audio/wav' THEN
    RETURN jsonb_build_object('prepared', false);
  END IF;

  expected_generated_path := 'sounds/' || owner_id || '/' || p_sound_id::text || '/playable-' || p_version_id::text;
  IF p_generated_path <> expected_generated_path THEN
    RETURN jsonb_build_object('prepared', false);
  END IF;

  INSERT INTO public."SoundMutationRecovery" (
    "soundId", token, operation, state, "expectedVersion", "versionId",
    "sourceStoragePath", "playableStoragePath", "generatedStoragePath", "stagedPlayablePath",
    "trimStartMs", "trimEndMs", "sourceDurationSec", "generatedDurationSec",
    "sourceMimeType", "generatedMimeType", "sourceSizeBytes", "generatedSizeBytes"
  ) VALUES (
    p_sound_id, p_token, 'trim', 'trim_uploading', p_expected_version, p_version_id,
    p_source_path,
    (SELECT "storagePath" FROM public."Sound" WHERE id = p_sound_id),
    p_generated_path, p_generated_path,
    p_trim_start_ms, p_trim_end_ms, p_source_duration_sec, p_generated_duration_sec,
    p_source_mime_type, p_generated_mime_type, p_source_size_bytes, p_generated_size_bytes
  );
  RETURN jsonb_build_object('prepared', true, 'generated_storage_path', p_generated_path);
END;
$$;

DROP FUNCTION IF EXISTS public.mark_sound_mutation_recovery(uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.mark_sound_mutation_recovery(
  p_sound_id uuid,
  p_token uuid,
  p_operation text,
  p_state text,
  p_last_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  current_state text;
  legal boolean := false;
BEGIN
  SELECT state INTO current_state
  FROM public."SoundMutationRecovery" AS recovery
  JOIN public."SoundMutationLease" AS lease
    ON lease."soundId" = recovery."soundId" AND lease.token = recovery.token
  WHERE recovery."soundId" = p_sound_id
    AND recovery.token = p_token
    AND recovery.operation = p_operation
    AND lease.operation = p_operation
    AND lease."expiresAt" > CURRENT_TIMESTAMP
  FOR UPDATE;
  IF current_state IS NULL THEN RETURN false; END IF;

  legal := p_state = current_state OR
    (current_state = 'trim_uploading' AND p_state IN ('trim_uploaded', 'trim_abandoned')) OR
    (current_state = 'trim_uploaded' AND p_state IN ('trim_committed', 'trim_abandoned')) OR
    (current_state = 'delete_staging' AND p_state IN ('delete_ready', 'restore_pending')) OR
    (current_state = 'delete_ready' AND p_state IN ('delete_objects_removed', 'restore_pending')) OR
    (current_state = 'delete_objects_removed' AND p_state IN ('delete_committed', 'restore_pending')) OR
    (current_state = 'restore_pending' AND p_state = 'delete_restored');
  IF NOT legal THEN RETURN false; END IF;

  UPDATE public."SoundMutationRecovery"
  SET state = p_state, "lastError" = p_last_error, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id AND token = p_token AND operation = p_operation;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.complete_sound_mutation_recovery(uuid, uuid);
CREATE OR REPLACE FUNCTION public.complete_sound_mutation_recovery(
  p_sound_id uuid,
  p_token uuid,
  p_operation text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_operation NOT IN ('trim', 'delete') THEN RETURN false; END IF;
  DELETE FROM public."SoundMutationRecovery" AS recovery
  USING public."SoundMutationLease" AS lease
  WHERE recovery."soundId" = p_sound_id
    AND recovery.token = p_token
    AND recovery.operation = p_operation
    AND lease."soundId" = recovery."soundId"
    AND lease.token = recovery.token
    AND lease.operation = p_operation
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND recovery.state IN ('trim_committed', 'trim_abandoned', 'delete_committed', 'delete_restored');
  RETURN FOUND;
END;
$$;

-- Claims an expired recovery with its original token. The same token binds all
-- subsequent mark/commit/complete calls and prevents a different worker from
-- finishing someone else's operation.
CREATE OR REPLACE FUNCTION public.claim_sound_mutation_recovery(
  p_recovery_id uuid,
  p_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recovery_row record;
  current_expiry timestamp with time zone;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid recovery lease request.';
  END IF;
  SELECT * INTO recovery_row
  FROM public."SoundMutationRecovery"
  WHERE id = p_recovery_id AND token = p_token
  FOR UPDATE;
  IF recovery_row.id IS NULL OR recovery_row.state NOT IN (
    'trim_uploading', 'trim_uploaded', 'trim_committed', 'trim_abandoned',
    'delete_staging', 'delete_ready', 'delete_objects_removed', 'restore_pending',
    'delete_committed', 'delete_restored'
  ) THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  SELECT "expiresAt" INTO current_expiry
  FROM public."SoundMutationLease"
  WHERE "soundId" = recovery_row."soundId"
  FOR UPDATE;
  IF current_expiry IS NOT NULL AND current_expiry > CURRENT_TIMESTAMP THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  INSERT INTO public."SoundMutationLease" ("soundId", token, operation, "expiresAt")
  VALUES (recovery_row."soundId", recovery_row.token, recovery_row.operation,
          CURRENT_TIMESTAMP + make_interval(secs => p_lease_seconds))
  ON CONFLICT ("soundId") DO UPDATE
  SET token = EXCLUDED.token, operation = EXCLUDED.operation,
      "expiresAt" = EXCLUDED."expiresAt", "createdAt" = CURRENT_TIMESTAMP;
  RETURN jsonb_build_object('claimed', true, 'sound_id', recovery_row."soundId",
                            'token', recovery_row.token, 'operation', recovery_row.operation);
END;
$$;

CREATE OR REPLACE FUNCTION public.defer_sound_mutation_recovery(
  p_sound_id uuid,
  p_token uuid,
  p_operation text,
  p_last_error text,
  p_max_attempts integer DEFAULT 3
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_max_attempts NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid recovery attempt limit.'; END IF;
  UPDATE public."SoundMutationRecovery" AS recovery
  SET attempts = recovery.attempts + 1,
      "nextAttemptAt" = CURRENT_TIMESTAMP + make_interval(secs => LEAST(60 * (recovery.attempts + 1), 900)),
      "lastError" = p_last_error,
      state = CASE WHEN recovery.attempts + 1 >= p_max_attempts THEN 'manual_required' ELSE recovery.state END,
      "updatedAt" = CURRENT_TIMESTAMP
  FROM public."SoundMutationLease" AS lease
  WHERE recovery."soundId" = p_sound_id
    AND recovery.token = p_token
    AND recovery.operation = p_operation
    AND lease."soundId" = recovery."soundId"
    AND lease.token = recovery.token
    AND lease.operation = p_operation
    AND lease."expiresAt" > CURRENT_TIMESTAMP;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_sound_trim(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_storage_path text,
  p_trim_start_ms integer,
  p_trim_end_ms integer,
  p_duration_sec numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  committed jsonb;
BEGIN
  WITH updated AS (
    UPDATE public."Sound" AS sound
    SET "storagePath" = p_storage_path,
        "trimStartMs" = p_trim_start_ms,
        "trimEndMs" = p_trim_end_ms,
        "durationSec" = p_duration_sec,
        "mutationVersion" = sound."mutationVersion" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."SoundMutationLease" AS lease,
         public."SoundMutationRecovery" AS recovery
    WHERE sound.id = p_sound_id
      AND lease."soundId" = sound.id
      AND lease.token = p_token
      AND lease.operation = 'trim'
      AND lease."expiresAt" > CURRENT_TIMESTAMP
      AND sound."mutationVersion" = p_expected_version
      AND recovery."soundId" = sound.id
      AND recovery.token = lease.token
      AND recovery.operation = 'trim'
      AND recovery."expectedVersion" = p_expected_version
      AND recovery.state = 'trim_uploaded'
      AND recovery."sourceStoragePath" = sound."sourceStoragePath"
      AND recovery."generatedStoragePath" = p_storage_path
      AND p_storage_path = 'sounds/' || sound."uploadedById" || '/' || sound.id::text || '/playable-' || recovery."versionId"::text
      AND p_trim_start_ms = recovery."trimStartMs"
      AND p_trim_end_ms = recovery."trimEndMs"
      AND p_duration_sec = recovery."generatedDurationSec"
    RETURNING sound.*
  )
  SELECT to_jsonb(updated) INTO committed FROM updated;
  IF committed IS NULL THEN RETURN 'null'::jsonb; END IF;

  UPDATE public."SoundMutationRecovery"
  SET state = 'trim_committed', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id AND token = p_token AND operation = 'trim';
  RETURN committed;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_sound_row_if_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public."Sound" AS sound
  USING public."SoundMutationLease" AS lease,
        public."SoundMutationRecovery" AS recovery
  WHERE sound.id = p_sound_id
    AND lease."soundId" = sound.id
    AND lease.token = p_token
    AND lease.operation = 'delete'
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND sound."mutationVersion" = p_expected_version
    AND recovery."soundId" = sound.id
    AND recovery.token = lease.token
    AND recovery.operation = 'delete'
    AND recovery."expectedVersion" = p_expected_version
    AND recovery.state IN ('delete_ready', 'delete_objects_removed');
  IF FOUND THEN
    UPDATE public."SoundMutationRecovery"
    SET state = 'delete_committed', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "soundId" = p_sound_id AND token = p_token AND operation = 'delete';
  END IF;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text, text, integer, integer, numeric, numeric, text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_sound_mutation_recovery(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.defer_sound_mutation_recovery(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text, text, integer, integer, numeric, numeric, text, text, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sound_mutation_recovery(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_sound_mutation_recovery(uuid, uuid, text, text, integer) TO service_role;
