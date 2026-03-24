-- CreateEnum
CREATE TYPE "HouseTransactionType" AS ENUM ('COMMISSION', 'BOT_PRIZE_WIN', 'REFUND_ISSUED');

-- AlterTable
ALTER TABLE "game_templates" ADD COLUMN     "botMaxSpend" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "botTotalSpent" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "house_wallet" (
    "id" TEXT NOT NULL DEFAULT 'house',
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_transactions" (
    "id" TEXT NOT NULL,
    "type" "HouseTransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "gameId" TEXT,
    "userId" TEXT,
    "balanceBefore" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "house_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "house_transactions_type_idx" ON "house_transactions"("type");

-- CreateIndex
CREATE INDEX "house_transactions_createdAt_idx" ON "house_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "house_transactions_userId_idx" ON "house_transactions"("userId");
