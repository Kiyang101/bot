-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'ERROR');

-- CreateTable
CREATE TABLE "BotRuntime" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" "BotStatus" NOT NULL DEFAULT 'STOPPED',
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotRuntime_pkey" PRIMARY KEY ("id")
);
