-- AlterEnum: Add FAILED status for insufficient-funds tracking
ALTER TYPE "ThirdPartyTxStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- AlterTable: Increase wallet balance precision to support decimal game amounts
ALTER TABLE "wallets" ALTER COLUMN "realBalance" TYPE DECIMAL(20,8);
ALTER TABLE "wallets" ALTER COLUMN "bonusBalance" TYPE DECIMAL(20,8);

-- AlterTable: Increase third-party transaction amount precision
ALTER TABLE "third_party_transactions" ALTER COLUMN "betAmount" TYPE DECIMAL(20,8);
ALTER TABLE "third_party_transactions" ALTER COLUMN "winAmount" TYPE DECIMAL(20,8);
ALTER TABLE "third_party_transactions" ALTER COLUMN "amount" TYPE DECIMAL(20,8);
ALTER TABLE "third_party_transactions" ALTER COLUMN "balanceBefore" TYPE DECIMAL(20,8);
ALTER TABLE "third_party_transactions" ALTER COLUMN "balanceAfter" TYPE DECIMAL(20,8);
