CREATE TABLE public."VoiceEntrancePreference" (
  "guildId" text NOT NULL,
  "userId" text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  "soundId" uuid REFERENCES public."Sound"(id) ON DELETE SET NULL,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("guildId", "userId")
);

ALTER TABLE public."VoiceEntrancePreference" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public."VoiceEntrancePreference" TO service_role;
