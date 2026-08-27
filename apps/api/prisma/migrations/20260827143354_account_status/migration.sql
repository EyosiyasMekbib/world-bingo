-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- Backfill from the boolean this supersedes. A disabled account of any kind
-- (player or staff) becomes SUSPENDED; RESTRICTED has no pre-existing analogue.
UPDATE "users" SET "accountStatus" = 'SUSPENDED' WHERE "isActive" = false;

-- CreateTable
CREATE TABLE "account_status_changes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "from" "AccountStatus" NOT NULL,
    "to" "AccountStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "category" TEXT,
    "actorId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_status_changes_userId_createdAt_idx" ON "account_status_changes"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "account_status_changes_expiresAt_idx" ON "account_status_changes"("expiresAt");

-- AddForeignKey
ALTER TABLE "account_status_changes" ADD CONSTRAINT "account_status_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;