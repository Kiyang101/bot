-- Global soundboard records. Ownership is by uploader, never by guild.
-- Audio objects live in the private `sounds` bucket and are accessed by the
-- server-side admin client, which creates short-lived signed URLs as needed.

CREATE TABLE public."Sound" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 40),
  color text NOT NULL CHECK (lower(color) IN ('#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#ed4245')),
  "storagePath" text NOT NULL,
  "sourceStoragePath" text NOT NULL,
  "mimeType" text NOT NULL CHECK ("mimeType" IN ('audio/mpeg', 'audio/wav', 'audio/ogg')),
  "sizeBytes" bigint NOT NULL CHECK ("sizeBytes" BETWEEN 0 AND 10485760),
  "durationSec" numeric CHECK ("durationSec" IS NULL OR "durationSec" >= 0),
  "uploadedById" text NOT NULL,
  "uploadedByName" text NOT NULL,
  shortcut text,
  "gainDb" numeric NOT NULL DEFAULT 0 CHECK ("gainDb" BETWEEN -24 AND 12),
  "fadeInMs" integer NOT NULL DEFAULT 0 CHECK ("fadeInMs" BETWEEN 0 AND 5000),
  "fadeOutMs" integer NOT NULL DEFAULT 0 CHECK ("fadeOutMs" BETWEEN 0 AND 5000),
  "trimStartMs" integer NOT NULL DEFAULT 0 CHECK ("trimStartMs" >= 0),
  "trimEndMs" integer NOT NULL CHECK (
    "trimEndMs" > "trimStartMs"
    AND "trimEndMs" - "trimStartMs" >= 100
  ),
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Sound_storagePath_contract"
    CHECK (
      "storagePath" = 'sounds/' || "uploadedById" || '/' || id::text || '/playable'
      OR "storagePath" LIKE 'sounds/' || "uploadedById" || '/' || id::text || '/playable-%'
    ),
  CONSTRAINT "Sound_sourceStoragePath_contract"
    CHECK ("sourceStoragePath" = 'sounds/' || "uploadedById" || '/' || id::text || '/source')
);

CREATE INDEX "Sound_sortOrder_createdAt_idx"
  ON public."Sound" ("sortOrder", "createdAt");

CREATE UNIQUE INDEX "Sound_shortcut_key"
  ON public."Sound" (shortcut)
  WHERE shortcut IS NOT NULL;

ALTER TABLE public."Sound" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public."Sound" TO service_role;

-- Storage DDL is supported by Supabase projects. No client storage policy is
-- granted: dashboard server actions use the service-role client exclusively.
INSERT INTO storage.buckets (id, name, public)
VALUES ('sounds', 'sounds', false)
ON CONFLICT (id) DO UPDATE SET public = false;
