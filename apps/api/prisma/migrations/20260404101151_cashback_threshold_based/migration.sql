/*
  Warnings:

  - You are about to drop the column `percentage` on the `cashback_promotions` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[promotionId,userId,periodStart]` on the table `cashback_disbursements` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `frequency` to the `cashback_promotions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lossThreshold` to the `cashback_promotions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `refundType` to the `cashback_promotions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `refundValue` to the `cashback_promotions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CashbackRefundType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "CashbackFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- DropIndex
DROP INDEX "cashback_disbursements_promotionId_userId_key";

-- AlterTable
ALTER TABLE "cashback_promotions"
DROP COLUMN IF EXISTS "percentage",
ADD COLUMN IF NOT EXISTS "frequency" "CashbackFrequency" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN IF NOT EXISTS "lossThreshold" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "refundType" "CashbackRefundType" NOT NULL DEFAULT 'PERCENTAGE',
ADD COLUMN IF NOT EXISTS "refundValue" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Remove temporary defaults so new rows must supply values
ALTER TABLE "cashback_promotions"
ALTER COLUMN "frequency" DROP DEFAULT,
ALTER COLUMN "lossThreshold" DROP DEFAULT,
ALTER COLUMN "refundType" DROP DEFAULT,
ALTER COLUMN "refundValue" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "cashback_disbursements_promotionId_periodStart_idx" ON "cashback_disbursements"("promotionId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "cashback_disbursements_promotionId_userId_periodStart_key" ON "cashback_disbursements"("promotionId", "userId", "periodStart");
