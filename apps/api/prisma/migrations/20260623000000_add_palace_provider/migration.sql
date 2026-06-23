-- AlterTable
ALTER TABLE "game_providers" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "provider_user_accounts" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalUserCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_user_accounts_providerId_idx" ON "provider_user_accounts"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_user_accounts_providerId_userId_key" ON "provider_user_accounts"("providerId", "userId");

-- AddForeignKey
ALTER TABLE "provider_user_accounts" ADD CONSTRAINT "provider_user_accounts_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "game_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
