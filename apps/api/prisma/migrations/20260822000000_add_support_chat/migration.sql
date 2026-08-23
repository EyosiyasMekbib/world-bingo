-- CreateEnum
CREATE TYPE "SupportConversationStatus" AS ENUM ('BOT', 'OPEN', 'ASSIGNED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportSenderRole" AS ENUM ('PLAYER', 'AI', 'AGENT', 'SYSTEM');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_REPLY';

-- CreateTable
CREATE TABLE "support_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SupportConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "aiTurnCount" INTEGER NOT NULL DEFAULT 0,
    "lowConfidenceStreak" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderRole" "SupportSenderRole" NOT NULL,
    "senderId" TEXT,
    "body" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "attachmentMime" TEXT,
    "readByPlayerAt" TIMESTAMP(3),
    "readByAgentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_conversations_status_lastMessageAt_idx" ON "support_conversations"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "support_conversations_userId_lastMessageAt_idx" ON "support_conversations"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "support_conversations_assignedToId_status_idx" ON "support_conversations"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "support_messages_conversationId_createdAt_idx" ON "support_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "support_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live conversation per player. Without this a double-tapped widget button
-- creates a second thread and the second one is invisible to its own author.
CREATE UNIQUE INDEX "support_conversations_one_live_per_user"
  ON "support_conversations" ("userId")
  WHERE "status" <> 'RESOLVED';
