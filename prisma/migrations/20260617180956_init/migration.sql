-- CreateEnum
CREATE TYPE "VoiceAction" AS ENUM ('JOIN', 'LEAVE', 'MOVE');

-- CreateTable
CREATE TABLE "GuildConfig" (
    "guildId" TEXT NOT NULL,
    "logChannelId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "VoiceEvent" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "action" "VoiceAction" NOT NULL,
    "channelId" TEXT,
    "channelName" TEXT,
    "fromChannelId" TEXT,
    "fromChannelName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceEvent_guildId_createdAt_idx" ON "VoiceEvent"("guildId", "createdAt");
