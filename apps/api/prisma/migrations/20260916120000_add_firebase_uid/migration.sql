-- Firebase Authentication uid, for phone (SMS) sign-in.
--
-- Nullable and unique: accounts that predate phone sign-in (and every staff
-- account, which still signs in with a password) carry NULL, and Postgres
-- allows any number of NULLs in a unique index. The uid is set the first time
-- a player completes an SMS sign-in — either on a new account, or on their
-- existing one when the verified number matches the phone already on file.
--
-- Matched on BEFORE `phone`, so a player whose number is later corrected by
-- support still signs in as themselves.

ALTER TABLE "users" ADD COLUMN "firebaseUid" TEXT;

CREATE UNIQUE INDEX "users_firebaseUid_key" ON "users"("firebaseUid");
