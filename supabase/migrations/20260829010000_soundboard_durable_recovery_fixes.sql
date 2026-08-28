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

-- Existing delete intents can recover their MIME while the Sound row still
-- exists. A post-row-delete intent without MIME is retained for manual review
-- rather than restoring with a guessed format.
UPDATE public."SoundMutationRecovery" AS recovery
SET "sourceMimeType" = sound."mimeType"
FROM public."Sound" AS sound
WHERE recovery."soundId" = sound.id
  AND recovery.operation = 'delete'
  AND recovery."sourceMimeType" IS NULL;

UPDATE public."SoundMutationRecovery"
SET state = 'manual_required',
    "lastError" = 'Delete recovery has no original source MIME type.'
WHERE operation = 'delete'
  AND "sourceMimeType" IS NULL
  AND state IN ('delete_staging', 'delete_ready', 'delete_objects_removed', 'restore_pending');

-- Uploads have no Sound row to anchor recovery until both Storage objects have
-- been written. Persist deterministic paths before the first upload so a
-- process crash cannot make an orphaned object undiscoverable.
CREATE TABLE IF NOT EXISTS public."SoundUploadRecovery" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "soundId" uuid NOT NULL UNIQUE,
  "uploadedById" text NOT NULL,
  "sourceStoragePath" text NOT NULL,
  "playableStoragePath" text NOT NULL,
  state text NOT NULL CHECK (state IN ('uploading', 'cleanup_pending')),
  "leaseToken" uuid NOT NULL DEFAULT gen_random_uuid(),
  "leaseExpiresAt" timestamp with time zone NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '15 minutes'),
  "claimToken" uuid,
  "claimExpiresAt" timestamp with time zone,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SoundUploadRecovery_paths_contract" CHECK (
    "sourceStoragePath" ~ '^sounds/[^/]+/[^/]+/source$'
    AND "playableStoragePath" ~ '^sounds/[^/]+/[^/]+/playable-[^/]+$'
  )
);

ALTER TABLE public."SoundUploadRecovery"
  ADD COLUMN IF NOT EXISTS "leaseToken" uuid,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "claimToken" uuid,
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" timestamp with time zone;

UPDATE public."SoundUploadRecovery"
SET "leaseToken" = COALESCE("leaseToken", gen_random_uuid()),
    "leaseExpiresAt" = COALESCE("leaseExpiresAt", "updatedAt" + interval '15 minutes');

ALTER TABLE public."SoundUploadRecovery"
  ALTER COLUMN "leaseToken" SET NOT NULL,
  ALTER COLUMN "leaseExpiresAt" SET NOT NULL;

ALTER TABLE public."SoundUploadRecovery" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."SoundUploadRecovery" TO service_role;

CREATE INDEX IF NOT EXISTS "SoundUploadRecovery_due_idx"
  ON public."SoundUploadRecovery" (state, "nextAttemptAt", "createdAt");

CREATE OR REPLACE FUNCTION public.prepare_sound_upload_recovery_tokenized(
  p_sound_id uuid,
  p_uploaded_by_id text,
  p_source_path text,
  p_playable_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  upload_token uuid := gen_random_uuid();
BEGIN
  IF p_uploaded_by_id IS NULL OR p_uploaded_by_id = '' OR p_uploaded_by_id ~ '[/\\]'
     OR p_source_path <> 'sounds/' || p_uploaded_by_id || '/' || p_sound_id::text || '/source'
     OR p_playable_path !~ ('^sounds/' || p_uploaded_by_id || '/' || p_sound_id::text || '/playable-[^/]+$') THEN
    RETURN jsonb_build_object('prepared', false);
  END IF;

  INSERT INTO public."SoundUploadRecovery" (
    "soundId", "uploadedById", "sourceStoragePath", "playableStoragePath", state,
    "leaseToken", "leaseExpiresAt"
  ) VALUES (
    p_sound_id, p_uploaded_by_id, p_source_path, p_playable_path, 'uploading',
    upload_token, CURRENT_TIMESTAMP + interval '15 minutes'
  );
  RETURN jsonb_build_object('prepared', true, 'token', upload_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_sound_upload_recovery(
  p_sound_id uuid,
  p_token uuid,
  p_lease_seconds integer DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid upload recovery lease request.';
  END IF;
  UPDATE public."SoundUploadRecovery"
  SET "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => p_lease_seconds),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id
    AND "leaseToken" = p_token
    AND state = 'uploading'
    AND "leaseExpiresAt" > CURRENT_TIMESTAMP;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_sound_upload_recovery_pending_tokenized(
  p_sound_id uuid,
  p_token uuid,
  p_last_error text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public."SoundUploadRecovery"
  SET state = 'cleanup_pending',
      "lastError" = p_last_error,
      "claimToken" = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id
    AND "leaseToken" = p_token
    AND state = 'uploading';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_sound_upload_recovery(
  p_recovery_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recovery_row public."SoundUploadRecovery"%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid upload recovery claim lease request.';
  END IF;
  SELECT * INTO recovery_row
  FROM public."SoundUploadRecovery"
  WHERE id = p_recovery_id
  FOR UPDATE;

  IF recovery_row.id IS NULL
     OR recovery_row.state NOT IN ('uploading', 'cleanup_pending')
     OR (recovery_row.state = 'uploading' AND recovery_row."leaseExpiresAt" > CURRENT_TIMESTAMP)
     OR (recovery_row."claimToken" IS NOT NULL AND recovery_row."claimExpiresAt" > CURRENT_TIMESTAMP) THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  UPDATE public."SoundUploadRecovery"
  SET state = 'cleanup_pending',
      "claimToken" = p_claim_token,
      "claimExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => p_lease_seconds),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE id = p_recovery_id;
  RETURN jsonb_build_object(
    'claimed', true,
    'sound_id', recovery_row."soundId",
    'source_storage_path', recovery_row."sourceStoragePath",
    'playable_storage_path', recovery_row."playableStoragePath"
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.defer_sound_upload_recovery(
  p_recovery_id uuid,
  p_claim_token uuid,
  p_last_error text,
  p_max_attempts integer DEFAULT 3
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_max_attempts NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Invalid upload recovery attempt limit.';
  END IF;
  UPDATE public."SoundUploadRecovery"
  SET attempts = attempts + 1,
      "nextAttemptAt" = CURRENT_TIMESTAMP + make_interval(secs => LEAST(60 * (attempts + 1), 900)),
      "lastError" = p_last_error,
      "claimToken" = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE id = p_recovery_id
    AND "claimToken" = p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sound_upload_recovery_tokenized(
  p_sound_id uuid,
  p_token uuid,
  p_source_path text,
  p_playable_path text,
  p_outcome text,
  p_source_absent boolean DEFAULT false,
  p_playable_absent boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recovery public."SoundUploadRecovery"%ROWTYPE;
  token_is_claim boolean;
  sound_row public."Sound"%ROWTYPE;
BEGIN
  SELECT * INTO recovery
  FROM public."SoundUploadRecovery"
  WHERE "soundId" = p_sound_id
  FOR UPDATE;
  IF recovery.id IS NULL THEN
    IF p_outcome = 'row_committed' THEN
      SELECT * INTO sound_row FROM public."Sound" WHERE id = p_sound_id;
      RETURN sound_row.id IS NOT NULL
        AND sound_row."sourceStoragePath" = p_source_path
        AND sound_row."storagePath" = p_playable_path
        AND NOT p_source_absent
        AND NOT p_playable_absent;
    END IF;
    RETURN p_outcome = 'objects_absent'
      AND p_source_absent
      AND p_playable_absent
      AND NOT EXISTS (SELECT 1 FROM public."Sound" WHERE id = p_sound_id);
  END IF;
  IF p_source_path <> recovery."sourceStoragePath"
     OR p_playable_path <> recovery."playableStoragePath"
     OR p_outcome NOT IN ('row_committed', 'objects_absent') THEN
    RETURN false;
  END IF;

  token_is_claim := recovery."claimToken" IS NOT NULL AND recovery."claimToken" = p_token;
  IF NOT token_is_claim AND recovery."leaseToken" <> p_token THEN
    RETURN false;
  END IF;
  IF NOT token_is_claim
     AND recovery."claimToken" IS NOT NULL
     AND recovery."claimExpiresAt" > CURRENT_TIMESTAMP THEN
    RETURN false;
  END IF;
  IF token_is_claim AND recovery."claimExpiresAt" <= CURRENT_TIMESTAMP THEN
    RETURN false;
  END IF;
  IF NOT token_is_claim AND recovery."leaseExpiresAt" <= CURRENT_TIMESTAMP AND p_outcome = 'row_committed' THEN
    RETURN false;
  END IF;

  IF p_outcome = 'row_committed' THEN
    IF recovery.state NOT IN ('uploading', 'cleanup_pending') OR p_source_absent OR p_playable_absent THEN
      RETURN false;
    END IF;
    SELECT * INTO sound_row FROM public."Sound" WHERE id = p_sound_id;
    IF sound_row.id IS NULL
       OR sound_row."sourceStoragePath" <> recovery."sourceStoragePath"
       OR sound_row."storagePath" <> recovery."playableStoragePath" THEN
      RETURN false;
    END IF;
  ELSE
    IF recovery.state <> 'cleanup_pending'
       OR NOT p_source_absent OR NOT p_playable_absent
       OR EXISTS (SELECT 1 FROM public."Sound" WHERE id = p_sound_id) THEN
      RETURN false;
    END IF;
  END IF;

  DELETE FROM public."SoundUploadRecovery" WHERE id = recovery.id;
  RETURN true;
END;
$$;

-- Keep the pre-token rollout contracts available. These wrappers deliberately
-- prove only the state/path facts available to their old callers.
CREATE OR REPLACE FUNCTION public.prepare_sound_upload_recovery(
  p_sound_id uuid,
  p_uploaded_by_id text,
  p_source_path text,
  p_playable_path text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_uploaded_by_id IS NULL OR p_uploaded_by_id = '' OR p_uploaded_by_id ~ '[/\\\\]'
     OR p_source_path <> 'sounds/' || p_uploaded_by_id || '/' || p_sound_id::text || '/source'
     OR p_playable_path !~ ('^sounds/' || p_uploaded_by_id || '/' || p_sound_id::text || '/playable-[^/]+$') THEN
    RETURN false;
  END IF;

  INSERT INTO public."SoundUploadRecovery" (
    "soundId", "uploadedById", "sourceStoragePath", "playableStoragePath", state
  ) VALUES (
    p_sound_id, p_uploaded_by_id, p_source_path, p_playable_path, 'uploading'
  );
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_sound_upload_recovery_pending(
  p_sound_id uuid,
  p_last_error text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public."SoundUploadRecovery"
  SET state = 'cleanup_pending',
      "lastError" = p_last_error,
      "claimToken" = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id
    AND state = 'uploading'
    AND "leaseExpiresAt" > CURRENT_TIMESTAMP;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sound_upload_recovery(
  p_sound_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public."SoundUploadRecovery" AS recovery
  USING public."Sound" AS sound
  WHERE recovery."soundId" = p_sound_id
    AND recovery.state IN ('uploading', 'cleanup_pending')
    AND sound.id = recovery."soundId"
    AND sound."sourceStoragePath" = recovery."sourceStoragePath"
    AND sound."storagePath" = recovery."playableStoragePath";
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_sound_upload_recovery(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.heartbeat_sound_upload_recovery(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_sound_upload_recovery_tokenized(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_sound_upload_recovery_pending(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_sound_upload_recovery_pending_tokenized(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_sound_upload_recovery(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.defer_sound_upload_recovery(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_sound_upload_recovery_tokenized(uuid, uuid, text, text, text, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_sound_upload_recovery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_sound_upload_recovery(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_sound_upload_recovery(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_sound_upload_recovery_tokenized(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sound_upload_recovery_pending(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sound_upload_recovery_pending_tokenized(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sound_upload_recovery(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_sound_upload_recovery(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sound_upload_recovery_tokenized(uuid, uuid, text, text, text, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sound_upload_recovery(uuid) TO service_role;

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

-- Keep the five-argument overload during the rolling compatibility window.
-- Older callers receive the same successful prepare acknowledgement when the
-- authoritative lease/version/path check is valid. They do not get a partial
-- replay row because the old payload lacks the measurements required for safe
-- replay; new callers use the complete overload below.
CREATE OR REPLACE FUNCTION public.prepare_sound_trim_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_version_id uuid,
  p_previous_playable_path text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."Sound" AS sound
    JOIN public."SoundMutationLease" AS lease ON lease."soundId" = sound.id
    WHERE sound.id = p_sound_id
      AND lease.token = p_token
      AND lease.operation = 'trim'
      AND lease."expiresAt" > CURRENT_TIMESTAMP
      AND sound."mutationVersion" = p_expected_version
      AND sound."storagePath" = p_previous_playable_path
  ) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

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

DROP FUNCTION IF EXISTS public.prepare_sound_delete_mutation(uuid, uuid, bigint, text, text, text, text);
CREATE OR REPLACE FUNCTION public.prepare_sound_delete_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_stage_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  owner_id text;
  source_path text;
  playable_path text;
  source_mime_type text;
  expected_source_path text;
  expected_playable_prefix text;
  staged_source_path text;
  staged_playable_path text;
BEGIN
  IF p_stage_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT sound."uploadedById", sound."sourceStoragePath", sound."storagePath", sound."mimeType"
  INTO owner_id, source_path, playable_path, source_mime_type
  FROM public."Sound" AS sound
  JOIN public."SoundMutationLease" AS lease ON lease."soundId" = sound.id
  WHERE sound.id = p_sound_id
    AND lease.token = p_token
    AND lease.operation = 'delete'
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND sound."mutationVersion" = p_expected_version;

  expected_source_path := 'sounds/' || owner_id || '/' || p_sound_id::text || '/source';
  expected_playable_prefix := 'sounds/' || owner_id || '/' || p_sound_id::text || '/playable';
  IF owner_id IS NULL
     OR source_path IS NULL
     OR playable_path IS NULL
     OR source_mime_type IS NULL
     OR source_mime_type NOT IN ('audio/mpeg', 'audio/wav', 'audio/ogg')
     OR source_path <> expected_source_path
     OR (playable_path <> expected_playable_prefix
         AND (left(playable_path, length(expected_playable_prefix) + 1) <> expected_playable_prefix || '-'
              OR position('/' IN substring(playable_path FROM length(expected_playable_prefix) + 2)) > 0)) THEN
    RETURN false;
  END IF;

  staged_source_path := 'sounds/' || owner_id || '/' || p_sound_id::text || '/staging/' || p_stage_id || '/source';
  staged_playable_path := 'sounds/' || owner_id || '/' || p_sound_id::text || '/staging/' || p_stage_id || '/playable';
  INSERT INTO public."SoundMutationRecovery" (
    "soundId", token, operation, state, "expectedVersion", "sourceMimeType",
    "sourceStoragePath", "playableStoragePath", "stagedSourcePath", "stagedPlayablePath"
  ) VALUES (
    p_sound_id, p_token, 'delete', 'delete_staging', p_expected_version, source_mime_type,
    source_path, playable_path, staged_source_path, staged_playable_path
  );
  RETURN true;
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

REVOKE ALL ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text, text, integer, integer, numeric, numeric, text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_sound_delete_mutation(uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_sound_mutation_recovery(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.defer_sound_mutation_recovery(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text, text, integer, integer, numeric, numeric, text, text, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_sound_delete_mutation(uuid, uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sound_mutation_recovery(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_sound_mutation_recovery(uuid, uuid, text, text, integer) TO service_role;
