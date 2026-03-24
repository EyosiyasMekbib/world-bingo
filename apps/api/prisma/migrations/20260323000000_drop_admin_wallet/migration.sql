-- DropTable
-- admin_wallet is superseded by house_wallet + house_transactions.
-- PayoutService (the only caller) was dead code; GameService.claimBingo
-- now handles payouts and writes directly to house_wallet.
DROP TABLE IF EXISTS "admin_wallet";
