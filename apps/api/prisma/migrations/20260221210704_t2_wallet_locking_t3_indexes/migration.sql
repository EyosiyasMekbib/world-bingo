-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "balanceAfter" DECIMAL(12,2),
ADD COLUMN     "balanceBefore" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "game_entries_userId_idx" ON "game_entries"("userId");

-- CreateIndex
CREATE INDEX "game_entries_gameId_idx" ON "game_entries"("gameId");

-- CreateIndex
CREATE INDEX "games_status_idx" ON "games"("status");

-- CreateIndex
CREATE INDEX "games_status_createdAt_idx" ON "games"("status", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_userId_idx" ON "transactions"("userId");

-- CreateIndex
CREATE INDEX "transactions_type_status_idx" ON "transactions"("type", "status");

-- CreateIndex
CREATE INDEX "transactions_userId_type_idx" ON "transactions"("userId", "type");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");
