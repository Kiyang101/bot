-- CreateTable
CREATE TABLE "MusicHistory" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "durationSec" INTEGER,
    "thumbnail" TEXT,
    "uploader" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MusicHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MusicHistory_guildId_createdAt_idx" ON "MusicHistory"("guildId", "createdAt");
