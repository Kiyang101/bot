-- Durable recovery records for Storage-backed Sound mutations.
-- This migration extends 20260828230000 without changing the Sound row shape
-- or removing any previously-created lease/cleanup functions. Every record is
-- server-only and keeps the paths needed by a reconciliation worker private.

CREATE TABLE IF NOT EXISTS public."SoundMutationRecovery" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "soundId" uuid,
  token uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('trim', 'delete')),
  state text NOT NULL CHECK (state IN (
    'trim_uploading', 'trim_uploaded', 'trim_committed',
    'delete_staging', 'delete_ready', 'delete_objects_removed',
    'delete_committed', 'restore_pending'
  )),
  "expectedVersion" bigint NOT NULL CHECK ("expectedVersion" >= 0),
  "sourceStoragePath" text,
  "playableStoragePath" text,
  "stagedSourcePath" text,
  "stagedPlayablePath" text,
  "lastError" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SoundMutationRecovery_paths_contract" CHECK (
    ("sourceStoragePath" IS NULL OR "sourceStoragePath" ~ '^sounds/[^/]+/[^/]+/source$')
    AND ("playableStoragePath" IS NULL OR "playableStoragePath" ~ '^sounds/[^/]+/[^/]+/playable(?:-[^/]+)?$')
    AND ("stagedSourcePath" IS NULL OR "stagedSourcePath" ~ '^sounds/[^/]+/[^/]+/staging/[^/]+/source$')
    AND ("stagedPlayablePath" IS NULL OR "stagedPlayablePath" ~ '^sounds/[^/]+/[^/]+/(?:playable-[^/]+|staging/[^/]+/playable)$')
  ),
  CONSTRAINT "SoundMutationRecovery_token_key" UNIQUE (token)
);

CREATE UNIQUE INDEX IF NOT EXISTS "SoundMutationRecovery_active_sound_key"
  ON public."SoundMutationRecovery" ("soundId")
  WHERE "soundId" IS NOT NULL AND state IN (
    'trim_uploading', 'trim_uploaded', 'delete_staging',
    'delete_ready', 'delete_objects_removed', 'restore_pending'
  );

CREATE INDEX IF NOT EXISTS "SoundMutationRecovery_state_updatedAt_idx"
  ON public."SoundMutationRecovery" (state, "updatedAt");

ALTER TABLE public."SoundMutationRecovery" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."SoundMutationRecovery" TO service_role;

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

  -- An expired lease is safe to replace only when no earlier worker still has
  -- an active recovery record that owns the sound's object transition.
  IF EXISTS (
    SELECT 1
    FROM public."SoundMutationRecovery"
    WHERE "soundId" = p_sound_id
      AND state IN (
        'trim_uploading', 'trim_uploaded', 'delete_staging',
        'delete_ready', 'delete_objects_removed', 'restore_pending'
      )
  ) THEN
    RETURN jsonb_build_object('acquired', false, 'mutation_version', current_version);
  END IF;

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
DECLARE
  owner_id text;
  staged_path text;
BEGIN
  SELECT "uploadedById" INTO owner_id
  FROM public."Sound" AS sound
  JOIN public."SoundMutationLease" AS lease ON lease."soundId" = sound.id
  WHERE sound.id = p_sound_id
    AND lease.token = p_token
    AND lease.operation = 'trim'
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND sound."mutationVersion" = p_expected_version
    AND sound."storagePath" = p_previous_playable_path;

  IF owner_id IS NULL THEN
    RETURN false;
  END IF;

  staged_path := 'sounds/' || owner_id || '/' || p_sound_id::text || '/playable-' || p_version_id::text;
  INSERT INTO public."SoundMutationRecovery" (
    "soundId", token, operation, state, "expectedVersion",
    "playableStoragePath", "stagedPlayablePath"
  ) VALUES (
    p_sound_id, p_token, 'trim', 'trim_uploading', p_expected_version,
    p_previous_playable_path, staged_path
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_sound_delete_mutation(
  p_sound_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_source_path text,
  p_playable_path text,
  p_staged_source_path text,
  p_staged_playable_path text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."Sound" AS sound
    JOIN public."SoundMutationLease" AS lease ON lease."soundId" = sound.id
    WHERE sound.id = p_sound_id
      AND lease.token = p_token
      AND lease.operation = 'delete'
      AND lease."expiresAt" > CURRENT_TIMESTAMP
      AND sound."mutationVersion" = p_expected_version
      AND sound."sourceStoragePath" = p_source_path
      AND sound."storagePath" = p_playable_path
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public."SoundMutationRecovery" (
    "soundId", token, operation, state, "expectedVersion",
    "sourceStoragePath", "playableStoragePath", "stagedSourcePath", "stagedPlayablePath"
  ) VALUES (
    p_sound_id, p_token, 'delete', 'delete_staging', p_expected_version,
    p_source_path, p_playable_path, p_staged_source_path, p_staged_playable_path
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_sound_mutation_recovery(
  p_sound_id uuid,
  p_token uuid,
  p_state text,
  p_last_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_state NOT IN (
    'trim_uploading', 'trim_uploaded', 'trim_committed',
    'delete_staging', 'delete_ready', 'delete_objects_removed',
    'delete_committed', 'restore_pending'
  ) THEN
    RAISE EXCEPTION 'Invalid sound mutation recovery state.';
  END IF;

  UPDATE public."SoundMutationRecovery"
  SET state = p_state,
      "lastError" = p_last_error,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id AND token = p_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sound_mutation_recovery(
  p_sound_id uuid,
  p_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public."SoundMutationRecovery"
  WHERE "soundId" = p_sound_id AND token = p_token;
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
      AND recovery.operation = 'trim'
      AND recovery.state = 'trim_uploaded'
      AND recovery."stagedPlayablePath" = p_storage_path
    RETURNING sound.*
  )
  SELECT to_jsonb(updated) INTO committed FROM updated;

  IF committed IS NULL THEN
    RETURN 'null'::jsonb;
  END IF;

  UPDATE public."SoundMutationRecovery"
  SET state = 'trim_committed', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "soundId" = p_sound_id AND token = p_token;
  DELETE FROM public."SoundMutationLease"
  WHERE "soundId" = p_sound_id AND token = p_token;
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
    AND recovery.state IN ('delete_ready', 'delete_objects_removed');

  IF FOUND THEN
    UPDATE public."SoundMutationRecovery"
    SET state = 'delete_committed', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "soundId" = p_sound_id AND token = p_token;
  END IF;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_sound_delete_mutation(uuid, uuid, bigint, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_sound_trim_mutation(uuid, uuid, bigint, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_sound_delete_mutation(uuid, uuid, bigint, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sound_mutation_recovery(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sound_mutation_recovery(uuid, uuid) TO service_role;
