-- Database-level backstop for platform rule #1 ("wallet balance never goes
-- below zero"). Previously enforced only by application-code convention (via
-- SELECT FOR UPDATE) with zero CHECK constraints anywhere in this schema's
-- migration history. This does not replace that application-level locking —
-- it's a last-resort guard so that any spend path (present or future) that
-- fails to prevent a double-spend gets a loud, immediate transaction failure
-- instead of a silently negative balance.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_realBalance_nonneg" CHECK ("realBalance" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_bonusBalance_nonneg" CHECK ("bonusBalance" >= 0);
