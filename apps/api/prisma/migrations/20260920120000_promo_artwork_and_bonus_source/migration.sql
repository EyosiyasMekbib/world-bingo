-- Bonus provenance, cashback payout limits, and promo artwork.
--
-- The player-facing promo surfaces need three things the schema could not say.
-- (1) A grant only records the rule that produced it, so anything credited
-- outside a deposit rule — a campaign, a cashback payout, a refund, a manual
-- admin credit — is indistinguishable in the bonus history; "source" names it
-- explicitly from now on. (2) Cashback promotions had no spend ceiling and no
-- say over when a payout lands, so caps and payoutTiming become columns rather
-- than hard-coded policy. (3) Promo artwork is one image per promo surface,
-- keyed by kind + the id of the thing it illustrates, which the admin panel
-- upserts against — hence the unique constraint rather than a position-only
-- table like "hero_banners".

-- CreateEnum
CREATE TYPE "BonusSource" AS ENUM ('FIRST_DEPOSIT', 'DAILY_DEPOSIT', 'WEEKLY_DEPOSIT', 'CASHBACK', 'CAMPAIGN', 'ADMIN', 'REFUND');

-- CreateEnum
CREATE TYPE "PromoKind" AS ENUM ('WELCOME', 'CASHBACK', 'DEPOSIT_RULE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "CashbackPayoutTiming" AS ENUM ('PERIOD_CLOSE', 'ON_THRESHOLD');

-- AlterEnum
-- An existing enum can only be appended to in place; Postgres has no way to
-- redefine "NotificationType" while the notifications.type column depends on
-- it. On PostgreSQL 11 and earlier more than one ADD VALUE per migration is
-- rejected (this repo runs 16, where it is fine). Nothing below writes either
-- new value, so the same-transaction restriction on using a freshly added
-- label never comes up.
ALTER TYPE "NotificationType" ADD VALUE 'BONUS_GRANTED';
ALTER TYPE "NotificationType" ADD VALUE 'BONUS_EXPIRING';

-- AlterTable
ALTER TABLE "bonus_grants" ADD COLUMN     "source" "BonusSource" NOT NULL DEFAULT 'ADMIN';

-- Backfill "source" from the only provenance already recorded: the rule the
-- grant points at. bonus_rules.type is DAILY_DEPOSIT | WEEKLY_DEPOSIT, so a
-- grant with a "ruleId" maps one-to-one onto the matching BonusSource value.
UPDATE "bonus_grants" AS g
SET "source" = 'DAILY_DEPOSIT'
FROM "bonus_rules" AS r
WHERE g."ruleId" = r."id" AND r."type" = 'DAILY_DEPOSIT';

UPDATE "bonus_grants" AS g
SET "source" = 'WEEKLY_DEPOSIT'
FROM "bonus_rules" AS r
WHERE g."ruleId" = r."id" AND r."type" = 'WEEKLY_DEPOSIT';

-- Everything with a NULL "ruleId" keeps the ADMIN default, and that is as far
-- as the data can honestly be read. Those rows were all written by the same
-- insert in bonus.service.ts with nothing but userId/amount/periodStart, so a
-- cashback payout, a campaign bonus, a refund and a manual admin credit are
-- byte-identical. "cashback_disbursements" cannot rescue them either: it holds
-- no grant id, and matching on (userId, amount) alone would mislabel any grant
-- that happens to share a player and a figure with a disbursement. ADMIN is
-- therefore the deliberate "unattributed" bucket for historical rows; only
-- grants created after this migration carry a true source.

-- AlterTable
ALTER TABLE "cashback_promotions" ADD COLUMN     "maxPayoutPerPlayer" DECIMAL(12,2),
ADD COLUMN     "periodBudget" DECIMAL(12,2),
ADD COLUMN     "payoutTiming" "CashbackPayoutTiming" NOT NULL DEFAULT 'PERIOD_CLOSE',
ADD COLUMN     "bonusValidityHours" INTEGER NOT NULL DEFAULT 168;

-- CreateTable
CREATE TABLE "promo_artworks" (
    "id" TEXT NOT NULL,
    "kind" "PromoKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "altText" TEXT NOT NULL DEFAULT '',
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_artworks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promo_artworks_kind_refId_key" ON "promo_artworks"("kind", "refId");

-- CreateIndex
CREATE INDEX "promo_artworks_position_idx" ON "promo_artworks"("position");
