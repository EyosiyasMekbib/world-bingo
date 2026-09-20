-- Cash agent network: shops holding prepaid float who credit players in
-- exchange for cash across a counter.

-- CreateEnum
CREATE TYPE "AgentLedgerType" AS ENUM ('TOP_UP', 'COMMISSION', 'FULFILLMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AgentDepositRequestStatus" AS ENUM ('PENDING', 'FULFILLED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "float" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deposit_requests" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "AgentDepositRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT,
    "transactionId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_deposit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_ledger" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "AgentLedgerType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceBefore" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "requestId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_userId_key" ON "agents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_deposit_requests_transactionId_key" ON "agent_deposit_requests"("transactionId");

-- CreateIndex
CREATE INDEX "agent_deposit_requests_userId_createdAt_idx" ON "agent_deposit_requests"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_deposit_requests_status_expiresAt_idx" ON "agent_deposit_requests"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "agent_deposit_requests_agentId_createdAt_idx" ON "agent_deposit_requests"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_ledger_requestId_key" ON "agent_ledger"("requestId");

-- CreateIndex
CREATE INDEX "agent_ledger_agentId_createdAt_idx" ON "agent_ledger"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_ledger_type_createdAt_idx" ON "agent_ledger"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deposit_requests" ADD CONSTRAINT "agent_deposit_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deposit_requests" ADD CONSTRAINT "agent_deposit_requests_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deposit_requests" ADD CONSTRAINT "agent_deposit_requests_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ledger" ADD CONSTRAINT "agent_ledger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ledger" ADD CONSTRAINT "agent_ledger_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "agent_deposit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database-level backstop for the agent equivalent of platform rule #1: an
-- agent's float is prepaid and must never go below zero. Application code takes
-- SELECT FOR UPDATE on the agent row before debiting, exactly as wallet spends
-- do; this CHECK is the last-resort guard so any path that fails to prevent an
-- overdraw fails loudly at commit instead of silently minting credit.
ALTER TABLE "agents" ADD CONSTRAINT "agents_float_nonneg" CHECK ("float" >= 0);

-- Partial unique indexes. Prisma's schema DSL cannot express a WHERE clause on
-- an index, so these live only here.
--
-- One live code at a time, globally unique: two agents cannot be looking at the
-- same code meaning two different requests, and the code space is only reused
-- once a request has settled.
CREATE UNIQUE INDEX "agent_deposit_requests_code_pending_key"
    ON "agent_deposit_requests"("code")
    WHERE "status" = 'PENDING';

-- One live code per player. Asking for a new code cancels the old one, so this
-- index is what makes that rule true under concurrency rather than by
-- convention.
CREATE UNIQUE INDEX "agent_deposit_requests_userId_pending_key"
    ON "agent_deposit_requests"("userId")
    WHERE "status" = 'PENDING';
