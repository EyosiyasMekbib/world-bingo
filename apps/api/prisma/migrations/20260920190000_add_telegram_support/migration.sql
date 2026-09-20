-- Telegram support bot: linking, notification pushes, and the staff group
-- bridge. See docs/telegram-support-bot.md.
--
-- Telegram is a CHANNEL attached to an existing phone/password account, never
-- a login: telegramChatId is a new, separate column from the pre-existing
-- telegramId (the login widget's identity). Nothing here changes how anyone
-- signs in.

-- CreateEnum
CREATE TYPE "SupportMessageSource" AS ENUM ('WEB', 'TELEGRAM');

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "telegramChatId" TEXT,
  ADD COLUMN "telegramLinkedAt" TIMESTAMP(3),
  ADD COLUMN "telegramNotifyEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "telegramBlockedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramChatId_key" ON "users"("telegramChatId");

-- AlterTable
ALTER TABLE "support_conversations" ADD COLUMN "telegramTopicId" INTEGER;

-- AlterTable
ALTER TABLE "support_messages" ADD COLUMN "source" "SupportMessageSource" NOT NULL DEFAULT 'WEB';

-- This migration touches support_conversations. schema.prisma cannot express
-- a partial index, so it is invisible to Prisma's own diffing and must be
-- re-asserted by hand in every migration that touches this table — see the
-- model comment in schema.prisma and the original migration,
-- 20260822000000_add_support_chat. IF NOT EXISTS makes this a no-op when the
-- index already survived untouched.
CREATE UNIQUE INDEX IF NOT EXISTS "support_conversations_one_live_per_user"
  ON "support_conversations" ("userId")
  WHERE "status" <> 'RESOLVED';
