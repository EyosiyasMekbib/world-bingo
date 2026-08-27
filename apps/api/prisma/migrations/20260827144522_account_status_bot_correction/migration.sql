-- Bot accounts are role PLAYER with passwordHash 'BOT_ACCOUNT', and
-- BotService toggles their `isActive` every pooling cycle: false means
-- "parked", not "suspended for fraud". The previous migration's backfill read
-- that boolean literally and marked every parked bot SUSPENDED.
--
-- Correct them, and leave bot pooling on `isActive` — routing it through
-- AccountStatusService would append an audit row, fire a player notification
-- and call the payment provider's freeze endpoint on every bot cycle.
UPDATE "users"
SET "accountStatus" = 'ACTIVE'
WHERE "passwordHash" = 'BOT_ACCOUNT'
  AND "accountStatus" = 'SUSPENDED';
