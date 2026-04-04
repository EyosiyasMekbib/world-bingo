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
ALTER TABLE "cashback_promotions" DROP COLUMN "percentage",
ADD COLUMN     "frequency" "CashbackFrequency" NOT NULL,
ADD COLUMN     "lossThreshold" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "refundType" "CashbackRefundType" NOT NULL,
ADD COLUMN     "refundValue" DECIMAL(10,2) NOT NULL;

-- CreateIndex
CREATE INDEX "cashback_disbursements_promotionId_periodStart_idx" ON "cashback_disbursements"("promotionId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "cashback_disbursements_promotionId_userId_periodStart_key" ON "cashback_disbursements"("promotionId", "userId", "periodStart");
