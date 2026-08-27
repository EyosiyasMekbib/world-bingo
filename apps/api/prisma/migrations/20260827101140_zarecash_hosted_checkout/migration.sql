-- AlterTable
ALTER TABLE "payment_methods" ADD COLUMN     "hostedCheckout" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logoUrl" TEXT;

-- CreateTable
CREATE TABLE "zarecash_checkout_sessions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "depositId" TEXT,
    "transactionId" TEXT,
    "methodCode" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zarecash_checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zarecash_checkout_sessions_sessionId_key" ON "zarecash_checkout_sessions"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "zarecash_checkout_sessions_depositId_key" ON "zarecash_checkout_sessions"("depositId");

-- CreateIndex
CREATE UNIQUE INDEX "zarecash_checkout_sessions_transactionId_key" ON "zarecash_checkout_sessions"("transactionId");

-- CreateIndex
CREATE INDEX "zarecash_checkout_sessions_userId_status_idx" ON "zarecash_checkout_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "zarecash_checkout_sessions_status_expiresAt_idx" ON "zarecash_checkout_sessions"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "zarecash_checkout_sessions" ADD CONSTRAINT "zarecash_checkout_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
