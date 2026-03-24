-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Dual Wallet, First Deposit Bonus, Cashback Promotions, Player Mgmt
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Dual Wallet: rename `balance` → `realBalance`, add `bonusBalance`
ALTER TABLE "wallets" RENAME COLUMN "balance" TO "realBalance";
ALTER TABLE "wallets" ADD COLUMN "bonusBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 2. Transaction: add bonus balance snapshot columns
ALTER TABLE "transactions" ADD COLUMN "bonusBalanceBefore" DECIMAL(12,2);
ALTER TABLE "transactions" ADD COLUMN "bonusBalanceAfter" DECIMAL(12,2);

-- 3. New transaction types
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'FIRST_DEPOSIT_BONUS';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'CASHBACK_BONUS';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'ADMIN_REAL_ADJUSTMENT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'ADMIN_BONUS_ADJUSTMENT';

-- 4. New notification type
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CASHBACK_AWARDED';

-- 5. Cashback Promotions
CREATE TABLE "cashback_promotions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cashback_promotions_pkey" PRIMARY KEY ("id")
);

-- 6. Cashback Disbursements (idempotent per promotion+user)
CREATE TABLE "cashback_disbursements" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cashback_disbursements_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one disbursement per user per promotion
CREATE UNIQUE INDEX "cashback_disbursements_promotionId_userId_key" ON "cashback_disbursements"("promotionId", "userId");

-- Foreign keys
ALTER TABLE "cashback_disbursements" ADD CONSTRAINT "cashback_disbursements_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "cashback_promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cashback_disbursements" ADD CONSTRAINT "cashback_disbursements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
