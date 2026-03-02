-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GameStatus" ADD VALUE 'LOCKING';
ALTER TYPE "GameStatus" ADD VALUE 'PAYOUT';
ALTER TYPE "GameStatus" ADD VALUE 'REFUNDING';

-- CreateTable
CREATE TABLE "admin_wallet" (
    "id" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_wallet_pkey" PRIMARY KEY ("id")
);
