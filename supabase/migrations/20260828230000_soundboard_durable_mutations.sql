-- Cross-worker coordination for Storage-backed Sound mutations.
-- Storage calls cannot participate in a Postgres transaction, so mutations use
-- a short-lived durable lease plus a mutation-version compare-and-swap commit.
ALTER TABLE public."Sound"
  ADD COLUMN IF NOT EXISTS "mutationVersion" bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public."SoundMutationLease" (
  "soundId" uuid PRIMARY KEY REFERENCES public."Sound" (id) ON DELETE CASCADE,
  token uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('trim', 'delete')),
  "expiresAt" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SoundMutationLease_expiresAt_idx"
  ON public."SoundMutationLease" ("expiresAt");

CREATE TABLE IF NOT EXISTS public."SoundCleanupTask" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "soundId" uuid,
  "objectPath" text NOT NULL CHECK (
    "objectPath" ~ '^sounds/[^/]+/[^/]+/(source|playable(-[^/]+)?|staging/[^/]+/(source|playable))$'
  ),
  "cleanupKind" text NOT NULL CHECK ("cleanupKind" IN ('delete_object', 'discard_stage')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SoundCleanupTask_due_idx"
  ON public."SoundCleanupTask" ("nextAttemptAt", "createdAt");

ALTER TABLE public."SoundMutationLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SoundCleanupTask" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."SoundMutationLease" TO service_role;
GRANT ALL ON public."SoundCleanupTask" TO service_role;

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

  -- Locking the row makes lease creation and Sound deletion serialize even
  -- when the lease row has not been created yet.
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

CREATE OR REPLACE FUNCTION public.release_sound_mutation(
  p_sound_id uuid,
  p_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM public."SoundMutationLease"
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
  IF NOT EXISTS (
    SELECT 1
    FROM public."Sound"
    WHERE id = p_sound_id
      AND p_storage_path LIKE 'sounds/' || "uploadedById" || '/' || id::text || '/playable-%'
  ) THEN
    RAISE EXCEPTION 'Invalid derived sound storage path.';
  END IF;

  WITH updated AS (
    UPDATE public."Sound" AS sound
    SET "storagePath" = p_storage_path,
        "trimStartMs" = p_trim_start_ms,
        "trimEndMs" = p_trim_end_ms,
        "durationSec" = p_duration_sec,
        "mutationVersion" = sound."mutationVersion" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."SoundMutationLease" AS lease
    WHERE sound.id = p_sound_id
      AND lease."soundId" = sound.id
      AND lease.token = p_token
      AND lease."expiresAt" > CURRENT_TIMESTAMP
      AND sound."mutationVersion" = p_expected_version
    RETURNING sound.*
  )
  SELECT to_jsonb(updated) INTO committed FROM updated;

  IF committed IS NULL THEN
    RETURN 'null'::jsonb;
  END IF;

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
  USING public."SoundMutationLease" AS lease
  WHERE sound.id = p_sound_id
    AND lease."soundId" = sound.id
    AND lease.token = p_token
    AND lease."expiresAt" > CURRENT_TIMESTAMP
    AND sound."mutationVersion" = p_expected_version;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_sound_cleanup(
  p_sound_id uuid,
  p_object_path text,
  p_cleanup_kind text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  task_id uuid;
BEGIN
  IF p_cleanup_kind NOT IN ('delete_object', 'discard_stage')
     OR p_object_path !~ '^sounds/[^/]+/[^/]+/(source|playable(-[^/]+)?|staging/[^/]+/(source|playable))$' THEN
    RAISE EXCEPTION 'Invalid sound cleanup task.';
  END IF;

  INSERT INTO public."SoundCleanupTask" ("soundId", "objectPath", "cleanupKind")
  VALUES (p_sound_id, p_object_path, p_cleanup_kind)
  RETURNING id INTO task_id;
  RETURN task_id;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_sound_mutation(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_sound_mutation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_sound_trim(uuid, uuid, bigint, text, integer, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_sound_row_if_mutation(uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_sound_cleanup(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_sound_mutation(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sound_mutation(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_sound_trim(uuid, uuid, bigint, text, integer, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_sound_row_if_mutation(uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_sound_cleanup(uuid, text, text) TO service_role;
