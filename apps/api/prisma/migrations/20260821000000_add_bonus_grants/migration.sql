-- CreateEnum
CREATE TYPE "BonusRuleType" AS ENUM ('DAILY_DEPOSIT', 'WEEKLY_DEPOSIT');

-- CreateEnum
CREATE TYPE "BonusRewardType" AS ENUM ('FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "BonusGrantStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SpendAccount" AS ENUM ('REAL', 'BONUS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'DAILY_DEPOSIT_BONUS';
ALTER TYPE "TransactionType" ADD VALUE 'WEEKLY_DEPOSIT_BONUS';
ALTER TYPE "TransactionType" ADD VALUE 'BONUS_EXPIRED';

-- AlterTable
ALTER TABLE "player_metrics" ADD COLUMN     "avgDailyDeposit" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "bonusExpiresAtSpend" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "spendAccount" "SpendAccount" NOT NULL DEFAULT 'REAL';

-- CreateTable
CREATE TABLE "bonus_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BonusRuleType" NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "rewardType" "BonusRewardType" NOT NULL,
    "rewardValue" DECIMAL(12,2) NOT NULL,
    "maxReward" DECIMAL(12,2),
    "validityHours" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bonus_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "remaining" DECIMAL(12,2) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "BonusGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bonus_rules_isActive_type_idx" ON "bonus_rules"("isActive", "type");

-- CreateIndex
CREATE INDEX "bonus_grants_userId_status_expiresAt_idx" ON "bonus_grants"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "bonus_grants_status_expiresAt_idx" ON "bonus_grants"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "bonus_grants_ruleId_userId_periodStart_key" ON "bonus_grants"("ruleId", "userId", "periodStart");

-- AddForeignKey
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "bonus_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_grants" ADD CONSTRAINT "bonus_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every pre-existing non-zero bonusBalance becomes one never-expiring,
-- ruleless lot. Without this the cached-balance invariant is false on day one.
--
-- Round bonusBalance to 2dp FIRST, on the wallet itself, before backfilling from
-- it — a pre-existing gap in CashbackService's percentage-refund math (no
-- ROUND_DOWN before crediting bonusBalance) means some wallets may carry more
-- than 2 decimal places today. Rounding both sides from the same UPDATE keeps
-- wallet.bonusBalance and the new lot in exact agreement post-migration; the
-- alternative (widening BonusGrant past 2dp) would be inconsistent with every
-- other money column in this schema (Transaction.amount, BonusRule.threshold/
-- rewardValue, CashbackPromotion.refundValue), all Decimal(12,2).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE "wallets" SET "bonusBalance" = ROUND("bonusBalance", 2) WHERE "bonusBalance" > 0;

INSERT INTO "bonus_grants" ("id", "userId", "ruleId", "amount", "remaining", "periodStart", "expiresAt", "status", "createdAt")
SELECT gen_random_uuid(), "userId", NULL, "bonusBalance", "bonusBalance", NOW(), NULL, 'ACTIVE', NOW()
FROM "wallets"
WHERE "bonusBalance" > 0;
