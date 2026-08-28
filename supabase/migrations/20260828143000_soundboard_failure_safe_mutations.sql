-- Allow immutable playable versions and make durationSec describe the measured
-- playable clip. Source bounds are authoritatively probed before each trim.
ALTER TABLE public."Sound"
  DROP CONSTRAINT IF EXISTS "Sound_storagePath_contract",
  DROP CONSTRAINT IF EXISTS "Sound_trimEndMs_check";

ALTER TABLE public."Sound"
  ADD CONSTRAINT "Sound_storagePath_contract" CHECK (
    "storagePath" = 'sounds/' || "uploadedById" || '/' || id::text || '/playable'
    OR "storagePath" LIKE 'sounds/' || "uploadedById" || '/' || id::text || '/playable-%'
  ),
  ADD CONSTRAINT "Sound_trimEndMs_check" CHECK (
    "trimEndMs" > "trimStartMs"
    AND "trimEndMs" - "trimStartMs" >= 100
  );

-- A single RPC call keeps a failed reorder from persisting only a prefix.
CREATE OR REPLACE FUNCTION public.reorder_sounds(sound_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF cardinality(sound_ids) <> (SELECT count(*) FROM public."Sound")
     OR cardinality(sound_ids) <> (SELECT count(DISTINCT id) FROM unnest(sound_ids) AS requested(id))
     OR EXISTS (
       SELECT 1 FROM unnest(sound_ids) AS requested(id)
       LEFT JOIN public."Sound" AS sound ON sound.id = requested.id
       WHERE sound.id IS NULL
     ) THEN
    RAISE EXCEPTION 'Sound order must include every global sound exactly once.';
  END IF;

  UPDATE public."Sound" AS sound
  SET "sortOrder" = requested.ordinality - 1,
      "updatedAt" = CURRENT_TIMESTAMP
  FROM unnest(sound_ids) WITH ORDINALITY AS requested(id, ordinality)
  WHERE sound.id = requested.id;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_sounds(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_sounds(uuid[]) TO service_role;
