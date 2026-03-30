-- CreateEnum
CREATE TYPE "GameProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "ThirdPartyTxType" AS ENUM ('BET', 'BET_RESULT', 'BET_DEBIT', 'BET_CREDIT', 'ROLLBACK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ThirdPartyTxStatus" AS ENUM ('COMPLETED', 'ROLLED_BACK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'TP_BET';
ALTER TYPE "TransactionType" ADD VALUE 'TP_WIN';
ALTER TYPE "TransactionType" ADD VALUE 'TP_ROLLBACK';
ALTER TYPE "TransactionType" ADD VALUE 'TP_ADJUSTMENT';

-- CreateTable
CREATE TABLE "game_providers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "GameProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "apiBaseUrl" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_vendors" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "game_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_games" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "gameCode" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "imageSquare" TEXT,
    "imageLandscape" TEXT,
    "languageCodes" TEXT[],
    "platformCodes" TEXT[],
    "currencyCodes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "third_party_transactions" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "externalTransactionId" TEXT,
    "betId" TEXT,
    "roundId" TEXT,
    "gameCode" TEXT,
    "type" "ThirdPartyTxType" NOT NULL,
    "status" "ThirdPartyTxStatus" NOT NULL DEFAULT 'COMPLETED',
    "betAmount" DECIMAL(12,2),
    "winAmount" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceBefore" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "rawRequest" JSONB,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "third_party_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_providers_code_key" ON "game_providers"("code");

-- CreateIndex
CREATE INDEX "game_vendors_providerId_isActive_idx" ON "game_vendors"("providerId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "game_vendors_providerId_code_key" ON "game_vendors"("providerId", "code");

-- CreateIndex
CREATE INDEX "provider_games_categoryCode_idx" ON "provider_games"("categoryCode");

-- CreateIndex
CREATE INDEX "provider_games_isActive_categoryCode_idx" ON "provider_games"("isActive", "categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "provider_games_providerId_gameCode_key" ON "provider_games"("providerId", "gameCode");

-- CreateIndex
CREATE INDEX "third_party_transactions_userId_idx" ON "third_party_transactions"("userId");

-- CreateIndex
CREATE INDEX "third_party_transactions_roundId_idx" ON "third_party_transactions"("roundId");

-- CreateIndex
CREATE INDEX "third_party_transactions_createdAt_idx" ON "third_party_transactions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "third_party_transactions_providerId_transactionId_key" ON "third_party_transactions"("providerId", "transactionId");

-- AddForeignKey
ALTER TABLE "game_vendors" ADD CONSTRAINT "game_vendors_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_games" ADD CONSTRAINT "provider_games_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_games" ADD CONSTRAINT "provider_games_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "game_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
