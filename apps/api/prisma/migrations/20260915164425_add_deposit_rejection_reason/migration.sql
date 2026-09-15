-- CreateEnum
CREATE TYPE "DepositRejectionReason" AS ENUM ('DUPLICATE_RECEIPT', 'AMOUNT_MISMATCH', 'PAYER_MISMATCH', 'UNREADABLE_RECEIPT', 'NOT_FOUND', 'OTHER');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "rejectionReason" "DepositRejectionReason";
