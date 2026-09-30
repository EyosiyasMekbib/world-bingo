-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';

-- CreateTable
CREATE TABLE "notification_broadcasts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentById" TEXT,
    "sentByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_broadcasts_createdAt_idx" ON "notification_broadcasts"("createdAt");
