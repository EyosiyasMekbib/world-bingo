-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "replacedByHash" TEXT;

-- CreateIndex
CREATE INDEX "refresh_tokens_rotatedAt_idx" ON "refresh_tokens"("rotatedAt");
