-- CreateEnum
CREATE TYPE "DepositVerificationStatus" AS ENUM ('PENDING', 'AUTO_CREDITED', 'MANUAL_REQUIRED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DepositVerificationSource" AS ENUM ('RECEIPT_FETCH');

-- AlterTable
ALTER TABLE "payment_methods" ADD COLUMN "autoVerify" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "deposit_verifications" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "status" "DepositVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DepositVerificationSource" NOT NULL DEFAULT 'RECEIPT_FETCH',
    "decision" TEXT,
    "decisionReasons" TEXT[],
    "receiverName" TEXT,
    "receiverNumberMasked" TEXT,
    "settledAmount" DECIMAL(12,2),
    "totalPaid" DECIMAL(12,2),
    "receiptStatus" TEXT,
    "receiptNumber" TEXT,
    "receiptTime" TIMESTAMP(3),
    "payerName" TEXT,
    "payerNumberMasked" TEXT,
    "rawSnapshot" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposit_verifications_transactionId_key" ON "deposit_verifications"("transactionId");

-- CreateIndex
CREATE INDEX "deposit_verifications_status_idx" ON "deposit_verifications"("status");

-- AddForeignKey
ALTER TABLE "deposit_verifications" ADD CONSTRAINT "deposit_verifications_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
