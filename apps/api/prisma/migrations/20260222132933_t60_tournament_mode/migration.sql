-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('REGISTRATION', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TOURNAMENT_STARTING';
ALTER TYPE "NotificationType" ADD VALUE 'TOURNAMENT_WON';
ALTER TYPE "NotificationType" ADD VALUE 'TOURNAMENT_ELIMINATED';

-- CreateTable
CREATE TABLE "tournaments" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'REGISTRATION',
    "entryFee" DECIMAL(10,2) NOT NULL,
    "maxPlayers" INTEGER NOT NULL DEFAULT 32,
    "currentPlayers" INTEGER NOT NULL DEFAULT 0,
    "prizePool" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "houseEdgePct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "winnerId" TEXT,
    "rounds" INTEGER NOT NULL DEFAULT 1,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_entries" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "eliminated" BOOLEAN NOT NULL DEFAULT false,
    "eliminatedAt" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_games" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,

    CONSTRAINT "tournament_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tournaments_status_idx" ON "tournaments"("status");

-- CreateIndex
CREATE INDEX "tournaments_status_scheduledAt_idx" ON "tournaments"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "tournament_entries_tournamentId_eliminated_idx" ON "tournament_entries"("tournamentId", "eliminated");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_entries_tournamentId_userId_key" ON "tournament_entries"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_games_gameId_key" ON "tournament_games"("gameId");

-- CreateIndex
CREATE INDEX "tournament_games_tournamentId_round_idx" ON "tournament_games"("tournamentId", "round");

-- AddForeignKey
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_games" ADD CONSTRAINT "tournament_games_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
