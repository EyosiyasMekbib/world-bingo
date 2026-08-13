-- CreateEnum
CREATE TYPE "PredictionMarketStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'RESOLVING', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PredictionOrderStatus" AS ENUM ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PredictionPositionStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'REFUNDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'PREDICTION_ORDER_HOLD';
ALTER TYPE "TransactionType" ADD VALUE 'PREDICTION_ORDER_RELEASE';
ALTER TYPE "TransactionType" ADD VALUE 'PREDICTION_WIN';
ALTER TYPE "TransactionType" ADD VALUE 'PREDICTION_REFUND';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PREDICTION_SETTLED';
ALTER TYPE "NotificationType" ADD VALUE 'PREDICTION_VOIDED';

-- AlterEnum
ALTER TYPE "HouseTransactionType" ADD VALUE 'PREDICTION_FEE';

-- CreateTable
CREATE TABLE "prediction_markets" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "status" "PredictionMarketStatus" NOT NULL DEFAULT 'DRAFT',
    "closesAt" TIMESTAMP(3) NOT NULL,
    "resolvesAt" TIMESTAMP(3),
    "shareValue" DECIMAL(12,2) NOT NULL DEFAULT 100,
    "feePct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "minOrderShares" INTEGER NOT NULL DEFAULT 1,
    "maxOrderShares" INTEGER NOT NULL DEFAULT 10000,
    "totalShares" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "winningOutcomeId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "disputeUntil" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prediction_markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_outcomes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "lastPrice" DECIMAL(12,2),

    CONSTRAINT "prediction_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_orders" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "limitPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "reservedReal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reservedBonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "PredictionOrderStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prediction_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_fills" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerOutcomeId" TEXT NOT NULL,
    "makerOutcomeId" TEXT NOT NULL,
    "takerPrice" DECIMAL(12,2) NOT NULL,
    "makerPrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_positions" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "costBasisReal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costBasisBonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "PredictionPositionStatus" NOT NULL DEFAULT 'OPEN',
    "payout" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "feePaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prediction_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prediction_markets_status_closesAt_idx" ON "prediction_markets"("status", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "prediction_outcomes_marketId_sortOrder_key" ON "prediction_outcomes"("marketId", "sortOrder");

-- CreateIndex
CREATE INDEX "prediction_orders_marketId_outcomeId_status_limitPrice_crea_idx" ON "prediction_orders"("marketId", "outcomeId", "status", "limitPrice", "createdAt");

-- CreateIndex
CREATE INDEX "prediction_orders_userId_status_idx" ON "prediction_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "prediction_fills_marketId_createdAt_idx" ON "prediction_fills"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "prediction_positions_userId_status_idx" ON "prediction_positions"("userId", "status");

-- CreateIndex
CREATE INDEX "prediction_positions_marketId_status_idx" ON "prediction_positions"("marketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prediction_positions_marketId_outcomeId_userId_key" ON "prediction_positions"("marketId", "outcomeId", "userId");

-- AddForeignKey
ALTER TABLE "prediction_outcomes" ADD CONSTRAINT "prediction_outcomes_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_orders" ADD CONSTRAINT "prediction_orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_orders" ADD CONSTRAINT "prediction_orders_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "prediction_outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_orders" ADD CONSTRAINT "prediction_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_fills" ADD CONSTRAINT "prediction_fills_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_positions" ADD CONSTRAINT "prediction_positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "prediction_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_positions" ADD CONSTRAINT "prediction_positions_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "prediction_outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_positions" ADD CONSTRAINT "prediction_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
