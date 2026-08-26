-- AlterTable
ALTER TABLE "payment_methods" ADD COLUMN     "gateway" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "gatewayMethodCode" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "gatewayRef" TEXT;

-- CreateTable
CREATE TABLE "zarecash_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "zarecash_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zarecash_events_type_idx" ON "zarecash_events"("type");

-- CreateIndex
CREATE INDEX "zarecash_events_processedAt_idx" ON "zarecash_events"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_gatewayRef_key" ON "transactions"("gatewayRef");
