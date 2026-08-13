-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CAMPAIGN_MESSAGE';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'CAMPAIGN_BONUS';

-- CreateTable
CREATE TABLE "player_metrics" (
    "userId" TEXT NOT NULL,
    "lifetimeDeposits" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "depositCount" INTEGER NOT NULL DEFAULT 0,
    "firstDepositAt" TIMESTAMP(3),
    "lastDepositAt" TIMESTAMP(3),
    "lifetimeWithdrawals" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "withdrawalCount" INTEGER NOT NULL DEFAULT 0,
    "lastWithdrawalAt" TIMESTAMP(3),
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "cartelasBought" INTEGER NOT NULL DEFAULT 0,
    "firstPlayedAt" TIMESTAMP(3),
    "lastPlayedAt" TIMESTAMP(3),
    "totalStaked" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalWon" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netLoss" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tpStaked" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tpWon" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lastTpPlayedAt" TIMESTAMP(3),
    "bonusReceived" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "daysSinceLastDeposit" INTEGER,
    "daysSinceLastPlay" INTEGER,
    "tenureDays" INTEGER NOT NULL DEFAULT 0,
    "realBalance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "bonusBalance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "serial" INTEGER,
    "username" TEXT,
    "phone" TEXT,
    "telegramId" TEXT,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_metrics_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "cachedCount" INTEGER,
    "countedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "rootId" TEXT NOT NULL,
    "segmentRulesSnapshot" JSONB NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "maxRecipients" INTEGER NOT NULL DEFAULT 1000,
    "maxTotalBonus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maxPerPlayer" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "lastEditedById" TEXT,
    "approvedById" TEXT,
    "createdByUsername" TEXT,
    "approvedByUsername" TEXT,
    "approvalNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalHash" TEXT,
    "snapshotSize" INTEGER,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "grantedTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_deliveries" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "rootId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CampaignDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "notificationId" TEXT,
    "transactionId" TEXT,
    "bonusAmount" DECIMAL(12,2),
    "skipReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "target" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "player_metrics_lastPlayedAt_idx" ON "player_metrics"("lastPlayedAt");

-- CreateIndex
CREATE INDEX "player_metrics_lastDepositAt_idx" ON "player_metrics"("lastDepositAt");

-- CreateIndex
CREATE INDEX "player_metrics_lifetimeDeposits_idx" ON "player_metrics"("lifetimeDeposits");

-- CreateIndex
CREATE INDEX "player_metrics_netLoss_idx" ON "player_metrics"("netLoss");

-- CreateIndex
CREATE INDEX "player_metrics_daysSinceLastPlay_idx" ON "player_metrics"("daysSinceLastPlay");

-- CreateIndex
CREATE INDEX "player_metrics_daysSinceLastDeposit_idx" ON "player_metrics"("daysSinceLastDeposit");

-- CreateIndex
CREATE UNIQUE INDEX "segments_name_key" ON "segments"("name");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaign_deliveries_campaignId_status_idx" ON "campaign_deliveries"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_deliveries_rootId_userId_key" ON "campaign_deliveries"("rootId", "userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- AddForeignKey
ALTER TABLE "player_metrics" ADD CONSTRAINT "player_metrics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

