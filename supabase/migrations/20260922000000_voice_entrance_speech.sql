ALTER TABLE public."VoiceEntrancePreference"
  ADD COLUMN mode text NOT NULL DEFAULT 'sound',
  ADD COLUMN "speechText" text,
  ADD COLUMN "speechProvider" text,
  ADD COLUMN "speechVoice" text,
  ADD COLUMN "speechPath" text,
  ADD COLUMN "speechDurationSec" double precision;

ALTER TABLE public."VoiceEntrancePreference"
  ADD CONSTRAINT voice_entrance_mode_check CHECK (mode IN ('sound', 'speech')),
  ADD CONSTRAINT voice_entrance_speech_check CHECK (
    (mode = 'sound' AND "speechText" IS NULL AND "speechProvider" IS NULL
      AND "speechVoice" IS NULL AND "speechPath" IS NULL AND "speechDurationSec" IS NULL)
    OR (mode = 'speech' AND "soundId" IS NULL AND "speechText" IS NOT NULL
      AND char_length("speechText") BETWEEN 1 AND 80
      AND "speechProvider" IN ('google', 'voicevox')
      AND "speechVoice" IS NOT NULL
      AND ("speechPath" IS NULL AND "speechDurationSec" IS NULL
        OR "speechPath" IS NOT NULL AND "speechDurationSec" BETWEEN 0.1 AND 5))
  ),
  ADD CONSTRAINT voice_entrance_speech_path_check CHECK (
    "speechPath" IS NULL OR "speechPath" ~ ('^entrances/' || "guildId" || '/' || "userId" || '/[0-9a-f-]{36}\.wav$')
  );

CREATE TABLE public."VoiceEntranceSpeechCleanup" (
  path text PRIMARY KEY,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" timestamp(3) without time zone
);
ALTER TABLE public."VoiceEntranceSpeechCleanup" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."VoiceEntranceSpeechCleanup" TO service_role;

-- Immutable object names must never be referenced again after retirement.
-- This also closes the race between a stale save and asynchronous storage cleanup.
CREATE FUNCTION public.reject_retired_entrance_speech() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW."speechPath" IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW."speechPath" IS DISTINCT FROM OLD."speechPath")
    AND EXISTS (SELECT 1 FROM public."VoiceEntranceSpeechCleanup" WHERE path = NEW."speechPath") THEN
    RAISE EXCEPTION 'Entrance speech asset has been retired; retry saving.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_retired_entrance_speech
  BEFORE INSERT OR UPDATE ON public."VoiceEntrancePreference"
  FOR EACH ROW EXECUTE FUNCTION public.reject_retired_entrance_speech();

CREATE FUNCTION public.queue_old_entrance_speech() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD."speechPath" IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD."speechPath" IS DISTINCT FROM NEW."speechPath") THEN
    INSERT INTO public."VoiceEntranceSpeechCleanup"(path) VALUES (OLD."speechPath")
      ON CONFLICT (path) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER queue_old_entrance_speech
  AFTER UPDATE OR DELETE ON public."VoiceEntrancePreference"
  FOR EACH ROW EXECUTE FUNCTION public.queue_old_entrance_speech();
