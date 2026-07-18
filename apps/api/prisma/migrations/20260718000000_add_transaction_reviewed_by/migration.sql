-- Audit + separation-of-duties: record which admin/clerk approved or rejected a
-- transaction. Nullable so existing rows are unaffected; indexed for per-clerk review.
ALTER TABLE "transactions" ADD COLUMN "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "transactions_reviewedById_idx" ON "transactions"("reviewedById");
