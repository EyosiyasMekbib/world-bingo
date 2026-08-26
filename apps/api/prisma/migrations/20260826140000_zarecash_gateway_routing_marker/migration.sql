-- Arms the admin double-pay guard at row creation instead of at submit-success.
--
-- `gatewayRef` is the UPSTREAM id and only exists once ZareCash has told us what
-- it is — which is after the payout POST has already been accepted. Between the
-- local debit and that write there is a multi-second window (ZARECASH_TIMEOUT_MS
-- per attempt, several attempts) in which a clerk working the review queue sees a
-- row with no gatewayRef, is let through the guard, and refunds or hand-pays a
-- payout ZareCash is simultaneously settling.
--
-- `gateway` is the ROUTING DECISION, written inside the same transaction that
-- debits the wallet, so the guard is armed before the job is even enqueued.
-- Additive only: nullable column + one index. Existing rows read as NULL, which
-- means "manual flow" — exactly what they are.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "gateway" TEXT;

-- CreateIndex
CREATE INDEX "transactions_gateway_status_idx" ON "transactions"("gateway", "status");

-- Drop the dead reconciliation cursor.
--
-- GET /v1/events orders createdAt DESC and returns nextCursor = the id of the
-- LAST (oldest) row of the page, so resuming from a stored cursor walked the
-- sweep strictly BACKWARDS through history: events created since the previous
-- run were never scanned, and once the walk reached the start of history the
-- cursor froze on an ancient page forever. The sweep now always starts from the
-- newest page and pages forward within a single run, so this key means nothing.
-- Leaving it behind would be a misleading dead setting.
DELETE FROM "site_settings" WHERE "key" = 'zarecash_events_cursor';
