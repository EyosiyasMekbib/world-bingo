# Accounting System Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every wallet mutation in the balance tracking system atomic, fully auditable, and comprehensively tested.

**Architecture:** Fix a critical non-atomic withdrawal-rejection bug in AdminService, extend the test database cleanup to cover house/settings tables, then add comprehensive test suites for all accounting paths that currently lack coverage: first-deposit bonus, bonus-first game-entry deduction, prize distribution snapshots, house wallet operations, and concurrent deposit approval.

**Tech Stack:** Fastify v5, Prisma 5 (PostgreSQL), Vitest + real DB integration tests, @prisma/client Decimal, @world-bingo/shared-types

---

## File Map

| Action | File | Why |
|--------|------|-----|
| Modify | `apps/api/src/services/admin.service.ts:98–152` | Fix withdrawal rejection: wrap in $transaction, add SELECT FOR UPDATE, create REFUND audit entry, push WebSocket |
| Modify | `apps/api/src/test/setup.ts:27–42` | Add houseTransaction, houseWallet, siteSetting to cleanDb so house-wallet tests start from a clean slate |
| Create | `apps/api/src/test/admin.service.test.ts` | Tests for reviewTransaction (withdrawal rejection audit trail, atomicity, invalid state guard) |
| Modify | `apps/api/src/test/wallet.service.test.ts` | Add first-deposit bonus tests and concurrent deposit-approval test |
| Modify | `apps/api/src/test/game.service.extended.test.ts` | Add bonus-first deduction tests and PRIZE_WIN balance-snapshot assertions |
| Create | `apps/api/src/test/house-wallet.service.test.ts` | Unit tests for HouseWalletService credit/debit/balance/summary |

---

## Task 1: Write Failing Tests That Expose the Withdrawal-Rejection Bug

**Files:**
- Create: `apps/api/src/test/admin.service.test.ts`

The current `AdminService.reviewTransaction` rejection path for a WITHDRAWAL:
1. Updates the transaction status in one call
2. Increments the wallet in a separate call — **not atomic**
3. Has no SELECT FOR UPDATE — **race condition possible**
4. Does not record balance snapshots anywhere
5. Does not create a compensation transaction — **audit trail is broken**
6. Does not call `NotificationService.pushWalletUpdate` — **UI balance stale**
7. Does not validate that the transaction is still `PENDING_REVIEW` before acting

These tests will **FAIL** until Task 2 fixes the implementation.

- [ ] **Step 1: Write the test file**

```typescript
// apps/api/src/test/admin.service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AdminService } from '../services/admin.service'
import { WalletService } from '../services/wallet.service'
import { prisma } from './setup'
import { TransactionType, PaymentStatus, GameStatus, PatternType } from '@world-bingo/shared-types'

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))

describe('AdminService.reviewTransaction', () => {
    let userId: string
    let withdrawalTxId: string

    beforeEach(async () => {
        const user = await prisma.user.create({
            data: {
                username: 'admin_test_user',
                phone: '+251900200001',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 1000 } },
            },
        })
        userId = user.id

        // Simulate a withdrawal request: balance deducted immediately
        const tx = await prisma.transaction.create({
            data: {
                userId,
                type: TransactionType.WITHDRAWAL,
                amount: 300,
                status: PaymentStatus.PENDING_REVIEW,
                note: 'Telebirr: 0912345678',
                balanceBefore: 1000,
                balanceAfter: 700,
                bonusBalanceBefore: 0,
                bonusBalanceAfter: 0,
            },
        })
        withdrawalTxId = tx.id

        // Balance was pre-deducted when withdrawal was requested
        await prisma.wallet.update({
            where: { userId },
            data: { realBalance: 700 },
        })
    })

    describe('WITHDRAWAL rejection', () => {
        it('should refund wallet when withdrawal is rejected', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Invalid account')

            const wallet = await WalletService.getBalance(userId)
            expect(Number(wallet.realBalance)).toBe(1000) // 700 + 300 refunded
        })

        it('should create a REFUND compensation transaction for audit trail', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Invalid account')

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND, referenceId: withdrawalTxId },
            })
            expect(refundTx).not.toBeNull()
            expect(Number(refundTx!.amount)).toBe(300)
            expect(refundTx!.status).toBe(PaymentStatus.APPROVED)
        })

        it('should record correct balance snapshots in the REFUND transaction', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'test')

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND, referenceId: withdrawalTxId },
            })
            expect(Number(refundTx!.balanceBefore)).toBe(700)  // balance at time of rejection
            expect(Number(refundTx!.balanceAfter)).toBe(1000)  // balance after refund
        })

        it('should mark the original WITHDRAWAL as REJECTED', async () => {
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED, 'Bad actor')

            const tx = await prisma.transaction.findUnique({ where: { id: withdrawalTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
            expect(tx!.note).toContain('Bad actor')
        })

        it('should push WebSocket balance update after rejection', async () => {
            const { NotificationService } = await import('../services/notification.service')

            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED)

            expect(NotificationService.pushWalletUpdate).toHaveBeenCalledWith(
                userId,
                1000, // refunded balance
                0,    // bonus balance unchanged
            )
        })

        it('should throw when rejecting an already-REJECTED withdrawal (prevent double-refund)', async () => {
            // First rejection
            await AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED)

            // Second rejection — must throw
            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED),
            ).rejects.toThrow()
        })

        it('should throw when rejecting an APPROVED withdrawal', async () => {
            await prisma.transaction.update({
                where: { id: withdrawalTxId },
                data: { status: PaymentStatus.APPROVED },
            })

            await expect(
                AdminService.reviewTransaction(withdrawalTxId, PaymentStatus.REJECTED),
            ).rejects.toThrow()
        })
    })

    describe('DEPOSIT rejection', () => {
        let depositTxId: string

        beforeEach(async () => {
            // Deposits are PENDING_REVIEW with no wallet change
            const tx = await prisma.transaction.create({
                data: {
                    userId,
                    type: TransactionType.DEPOSIT,
                    amount: 500,
                    status: PaymentStatus.PENDING_REVIEW,
                },
            })
            depositTxId = tx.id
        })

        it('should NOT change wallet balance when rejecting a deposit', async () => {
            const beforeWallet = await WalletService.getBalance(userId)

            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED, 'Fake receipt')

            const afterWallet = await WalletService.getBalance(userId)
            expect(Number(afterWallet.realBalance)).toBe(Number(beforeWallet.realBalance))
        })

        it('should mark deposit as REJECTED', async () => {
            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED, 'Fake receipt')

            const tx = await prisma.transaction.findUnique({ where: { id: depositTxId } })
            expect(tx!.status).toBe(PaymentStatus.REJECTED)
        })

        it('should NOT create a REFUND transaction for a rejected deposit', async () => {
            await AdminService.reviewTransaction(depositTxId, PaymentStatus.REJECTED)

            const refundTx = await prisma.transaction.findFirst({
                where: { userId, type: TransactionType.REFUND },
            })
            expect(refundTx).toBeNull()
        })
    })
})
```

- [ ] **Step 2: Run tests to verify they FAIL**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo
pnpm --filter @world-bingo/api test -- --reporter=verbose admin.service
```

Expected: FAIL on "should create a REFUND compensation transaction", "should record correct balance snapshots", "should push WebSocket balance update", "should throw when rejecting an already-REJECTED withdrawal", "should throw when rejecting an APPROVED withdrawal"

- [ ] **Step 3: Commit failing tests**

```bash
git add apps/api/src/test/admin.service.test.ts
git commit -m "test(admin): add failing tests for withdrawal rejection accounting gaps"
```

---

## Task 2: Fix AdminService.reviewTransaction — Withdrawal Rejection

**Files:**
- Modify: `apps/api/src/services/admin.service.ts:98–152`

Replace the existing `reviewTransaction` method with the version below. The key changes are:
- Read transaction first to validate status before acting
- For WITHDRAWAL + REJECTED: wrap everything in `prisma.$transaction()`, use `SELECT FOR UPDATE`, create a REFUND compensation transaction with balance snapshots, then push WebSocket after commit
- For DEPOSIT + REJECTED: simple status update (no wallet change, no $transaction needed)

- [ ] **Step 1: Add Decimal import to admin.service.ts**

At the top of `apps/api/src/services/admin.service.ts`, the file already imports from `@world-bingo/shared-types`. Add the Decimal import:

```typescript
// apps/api/src/services/admin.service.ts — top of file, after existing imports
import { Decimal } from '@prisma/client/runtime/library'
```

Verify the existing imports at the top of the file look like:
```typescript
import prisma from '../lib/prisma'
import { GameStatus, PaymentStatus, TransactionType, UserRole, NotificationType } from '@world-bingo/shared-types'
import { WalletService } from './wallet.service'
import { NotificationService } from './notification.service'
import { Decimal } from '@prisma/client/runtime/library'
```

- [ ] **Step 2: Replace the reviewTransaction method**

Find the method starting at line 98:
```typescript
    static async reviewTransaction(transactionId: string, status: PaymentStatus, note?: string) {
```

Replace the entire method body (lines 98–152) with:

```typescript
    static async reviewTransaction(transactionId: string, status: PaymentStatus, note?: string) {
        if (status === PaymentStatus.APPROVED) {
            // Check transaction type — deposits go through WalletService (credits wallet)
            const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
            if (!tx) throw new Error('Transaction not found')

            if (tx.type === TransactionType.DEPOSIT) {
                return await WalletService.approveDeposit(transactionId)
            }

            // Withdrawal approval — just mark as APPROVED (balance was already deducted on request)
            const updated = await prisma.transaction.update({
                where: { id: transactionId },
                data: { status: PaymentStatus.APPROVED, note },
            })
            await NotificationService.create(
                updated.userId,
                NotificationType.WITHDRAWAL_PROCESSED,
                'Withdrawal Processed ✅',
                `Your withdrawal of ${Number(updated.amount).toFixed(2)} ETB has been transferred.`,
                { transactionId, amount: Number(updated.amount) },
            ).catch(() => {})
            return updated
        }

        // ── REJECTED path ────────────────────────────────────────────────────
        const existing = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!existing) throw new Error('Transaction not found')
        if (existing.status !== PaymentStatus.PENDING_REVIEW) {
            throw new Error(`Transaction is not pending review (current status: ${existing.status})`)
        }

        if (existing.type === TransactionType.WITHDRAWAL) {
            // Withdrawal rejection must:
            // 1. Mark the withdrawal REJECTED
            // 2. Re-credit the wallet using SELECT FOR UPDATE (was deducted on request)
            // 3. Create a REFUND compensation transaction for the audit trail
            // All in one DB transaction to prevent partial state on crash.
            const result = await prisma.$transaction(async (tx) => {
                // Mark withdrawal rejected
                const updated = await tx.transaction.update({
                    where: { id: transactionId },
                    data: { status: PaymentStatus.REJECTED, note },
                })

                // Lock wallet row before reading balance
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${existing.userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) throw new Error('Wallet not found')

                const realBefore = new Decimal(wallet.realBalance)
                const realAfter = realBefore.plus(new Decimal(existing.amount))
                const bonusBefore = new Decimal(wallet.bonusBalance)

                // Re-credit wallet
                await tx.wallet.update({
                    where: { userId: existing.userId },
                    data: { realBalance: { increment: existing.amount } },
                })

                // Create compensation transaction so audit trail shows the wallet credit
                await tx.transaction.create({
                    data: {
                        userId: existing.userId,
                        type: TransactionType.REFUND,
                        amount: existing.amount,
                        status: PaymentStatus.APPROVED,
                        referenceId: transactionId, // links back to the rejected withdrawal
                        note: `Refund for rejected withdrawal${note ? `: ${note}` : ''}`,
                        balanceBefore: realBefore,
                        balanceAfter: realAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusBefore,
                    },
                })

                return { updated, realAfter, bonusBefore }
            })

            // Push real-time balance update after commit
            NotificationService.pushWalletUpdate(
                existing.userId,
                result.realAfter.toNumber(),
                result.bonusBefore.toNumber(),
            )

            await NotificationService.create(
                existing.userId,
                NotificationType.WITHDRAWAL_PROCESSED,
                'Withdrawal Rejected',
                `Your withdrawal of ${Number(existing.amount).toFixed(2)} ETB was rejected and refunded to your wallet.${note ? ` Reason: ${note}` : ''}`,
                { transactionId, amount: Number(existing.amount), note },
            ).catch(() => {})

            return result.updated
        }

        // DEPOSIT rejection — no wallet change (balance was never credited)
        const transaction = await prisma.transaction.update({
            where: { id: transactionId },
            data: { status: PaymentStatus.REJECTED, note },
        })

        await NotificationService.create(
            transaction.userId,
            NotificationType.DEPOSIT_REJECTED,
            'Deposit Rejected',
            `Your deposit of ${Number(transaction.amount).toFixed(2)} ETB was rejected.${note ? ` Reason: ${note}` : ''}`,
            { transactionId, amount: Number(transaction.amount), note },
        ).catch(() => {})

        return transaction
    }
```

- [ ] **Step 3: Run failing tests to verify they now pass**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose admin.service
```

Expected output: all tests PASS

- [ ] **Step 4: Run full test suite to check for regressions**

```bash
pnpm --filter @world-bingo/api test
```

Expected: all previously passing tests still pass

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/admin.service.ts
git commit -m "fix(admin): make withdrawal rejection atomic with SELECT FOR UPDATE and audit trail"
```

---

## Task 3: Update Test Setup to Clean House and Settings Tables

**Files:**
- Modify: `apps/api/src/test/setup.ts:27–42`

Without this, house-wallet tests (Task 7) and first-deposit-bonus tests (Task 5) will see stale rows from previous tests and produce non-deterministic results.

- [ ] **Step 1: Write the failing test assertion to confirm the need**

Run the existing tests twice to verify they pass cleanly. If any test depends on a fresh `houseWallet` or `siteSetting`, it will see leftover data without this fix.

- [ ] **Step 2: Add missing tables to cleanDb**

In `apps/api/src/test/setup.ts`, find `async function cleanDb()` and add three lines before the existing `prisma.notification.deleteMany()`:

```typescript
async function cleanDb() {
    await prisma.siteSetting.deleteMany()
    await prisma.houseTransaction.deleteMany()
    await prisma.houseWallet.deleteMany()
    await prisma.notification.deleteMany()
    await prisma.refreshToken.deleteMany()
    await prisma.jackpotWin.deleteMany()
    await prisma.jackpot.deleteMany()
    await prisma.referralReward.deleteMany()
    await prisma.tournamentEntry.deleteMany()
    await prisma.tournamentGame.deleteMany()
    await prisma.transaction.deleteMany()
    await prisma.gameEntry.deleteMany()
    await prisma.cartela.deleteMany()
    await prisma.game.deleteMany()
    await prisma.tournament.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.user.deleteMany()
}
```

- [ ] **Step 3: Run full test suite to verify nothing broke**

```bash
pnpm --filter @world-bingo/api test
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/setup.ts
git commit -m "test(setup): clean houseWallet, houseTransaction, siteSetting between tests"
```

---

## Task 4: Add First-Deposit Bonus Tests to WalletService

**Files:**
- Modify: `apps/api/src/test/wallet.service.test.ts`

The `approveDeposit` bonus path (lines 81–112 in wallet.service.ts) checks `siteSetting.first_deposit_bonus_amount`. No test currently exercises this path. These tests verify the entire bonus lifecycle.

- [ ] **Step 1: Add describe block to wallet.service.test.ts**

Append after the existing `describe('requestWithdrawal', ...)` block:

```typescript
    describe('approveDeposit — first deposit bonus', () => {
        beforeEach(async () => {
            // Create the site setting that triggers first-deposit bonus
            await prisma.siteSetting.create({
                data: { key: 'first_deposit_bonus_amount', value: '100' },
            })
        })

        it('should credit bonus balance on first deposit when setting is configured', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.realBalance)).toBe(1000)  // 500 existing + 500 deposited
            expect(Number(wallet.bonusBalance)).toBe(100)  // first deposit bonus
        })

        it('should create a FIRST_DEPOSIT_BONUS transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const bonusTx = await prisma.transaction.findFirst({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTx).not.toBeNull()
            expect(Number(bonusTx!.amount)).toBe(100)
            expect(bonusTx!.status).toBe(PaymentStatus.APPROVED)
        })

        it('should record correct bonus balance snapshots in FIRST_DEPOSIT_BONUS transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 200 })
            await WalletService.approveDeposit(deposit.id)

            const bonusTx = await prisma.transaction.findFirst({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            // bonusBefore = 0 (fresh user), bonusAfter = 100 (bonus awarded)
            expect(Number(bonusTx!.bonusBalanceBefore)).toBe(0)
            expect(Number(bonusTx!.bonusBalanceAfter)).toBe(100)
        })

        it('should NOT award bonus on second and subsequent deposits', async () => {
            // First deposit
            const d1 = await WalletService.initiateDeposit(testUserId, { amount: 200 })
            await WalletService.approveDeposit(d1.id)

            // Second deposit
            const d2 = await WalletService.initiateDeposit(testUserId, { amount: 300 })
            await WalletService.approveDeposit(d2.id)

            const bonusTxCount = await prisma.transaction.count({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTxCount).toBe(1) // only the first deposit triggers bonus
        })

        it('should NOT award bonus when setting value is 0', async () => {
            await prisma.siteSetting.update({
                where: { key: 'first_deposit_bonus_amount' },
                data: { value: '0' },
            })

            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.bonusBalance)).toBe(0)

            const bonusTxCount = await prisma.transaction.count({
                where: { userId: testUserId, type: TransactionType.FIRST_DEPOSIT_BONUS },
            })
            expect(bonusTxCount).toBe(0)
        })

        it('should NOT award bonus when setting is absent', async () => {
            await prisma.siteSetting.deleteMany()

            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 500 })
            await WalletService.approveDeposit(deposit.id)

            const wallet = await WalletService.getBalance(testUserId)
            expect(Number(wallet.bonusBalance)).toBe(0)
        })
    })

    describe('approveDeposit — concurrent approval (double-credit prevention)', () => {
        it('should only credit once if two approvals race for the same transaction', async () => {
            const deposit = await WalletService.initiateDeposit(testUserId, { amount: 300 })

            // Fire two concurrent approvals
            const results = await Promise.allSettled([
                WalletService.approveDeposit(deposit.id),
                WalletService.approveDeposit(deposit.id),
            ])

            const successes = results.filter((r) => r.status === 'fulfilled')
            const failures = results.filter((r) => r.status === 'rejected')

            expect(successes.length).toBe(1)
            expect(failures.length).toBe(1)

            // Balance should reflect exactly one credit, not two
            const wallet = await WalletService.getBalance(testUserId)
            // Starting balance was 500, deposit was 300 → exactly 800
            expect(Number(wallet.realBalance)).toBe(800)
        })
    })
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose wallet.service
```

Expected: all tests pass (these cover existing correct behavior)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/wallet.service.test.ts
git commit -m "test(wallet): add first-deposit bonus and concurrent approval test coverage"
```

---

## Task 5: Add Bonus-First Deduction Tests to game.service.extended.test.ts

**Files:**
- Modify: `apps/api/src/test/game.service.extended.test.ts`

The current `joinGame — Extended` tests always use `realBalance=500, bonusBalance=0`. The implementation deducts bonus first (game.service.ts lines 95–99), but this is untested. Add a describe block after the existing `GameService.joinGame — Extended` suite.

- [ ] **Step 1: Add bonus-first describe block**

Append after the closing brace of `describe('GameService.joinGame — Extended', ...)`:

```typescript
describe('GameService.joinGame — bonus-first deduction', () => {
    let gameId: string

    beforeEach(async () => {
        const game = await createGame({ ticketPrice: 50 })
        gameId = game.id
    })

    it('should deduct bonus balance before real balance', async () => {
        // User has 100 bonus + 500 real. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_first_1',
                phone: '+251911100001',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 100 } },
            },
        })
        const c = await createCartela('BF-C1')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(50)  // 100 - 50 (full cost from bonus)
        expect(Number(wallet!.realBalance)).toBe(500)  // untouched
    })

    it('should use real balance only when bonus is exhausted', async () => {
        // User has 30 bonus + 500 real. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_first_2',
                phone: '+251911100002',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 30 } },
            },
        })
        const c = await createCartela('BF-C2')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(0)   // 30 - 30 (all bonus consumed)
        expect(Number(wallet!.realBalance)).toBe(480)  // 500 - 20 (remaining cost)
    })

    it('should record correct bonus balance snapshots in GAME_ENTRY transaction', async () => {
        const user = await prisma.user.create({
            data: {
                username: 'bonus_snap',
                phone: '+251911100003',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 500, bonusBalance: 100 } },
            },
        })
        const c = await createCartela('BF-C3')
        await GameService.joinGame(user.id, gameId, [c.serial])

        const tx = await prisma.transaction.findFirst({
            where: { userId: user.id, type: TransactionType.GAME_ENTRY },
        })
        expect(tx).not.toBeNull()
        expect(Number(tx!.bonusBalanceBefore)).toBe(100)
        expect(Number(tx!.bonusBalanceAfter)).toBe(50)  // 100 - 50
        expect(Number(tx!.balanceBefore)).toBe(500)     // real untouched
        expect(Number(tx!.balanceAfter)).toBe(500)
    })

    it('should succeed using only bonus balance when real balance is 0', async () => {
        // User has 0 real + 200 bonus. Cost = 50.
        const user = await prisma.user.create({
            data: {
                username: 'bonus_only',
                phone: '+251911100004',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 0, bonusBalance: 200 } },
            },
        })
        const c = await createCartela('BF-C4')

        // Should succeed — total available (200) >= cost (50)
        const entries = await GameService.joinGame(user.id, gameId, [c.serial])
        expect(entries).toHaveLength(1)

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        expect(Number(wallet!.bonusBalance)).toBe(150)
        expect(Number(wallet!.realBalance)).toBe(0)
    })

    it('should fail when combined real + bonus is less than cost', async () => {
        const user = await prisma.user.create({
            data: {
                username: 'bonus_poor',
                phone: '+251911100005',
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 20, bonusBalance: 20 } },
            },
        })
        const c = await createCartela('BF-C5')

        // Total available = 40, cost = 50 → insufficient
        await expect(
            GameService.joinGame(user.id, gameId, [c.serial]),
        ).rejects.toThrow('Insufficient funds')
    })
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose game.service.extended
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/game.service.extended.test.ts
git commit -m "test(game): add bonus-first deduction coverage for joinGame"
```

---

## Task 6: Add PRIZE_WIN Balance Snapshot and House Commission Tests

**Files:**
- Modify: `apps/api/src/test/game.service.extended.test.ts`

The existing claimBingo tests verify the wallet is credited and a PRIZE_WIN transaction exists, but don't assert balance snapshots (balanceBefore/balanceAfter) or that the house commission is recorded in HouseWallet. Add these inside a new describe block.

- [ ] **Step 1: Add prize snapshot and house commission describe block**

Append after the `describe('GameService.claimBingo — Edge Cases', ...)` closing brace:

```typescript
describe('GameService.claimBingo — balance snapshots and house accounting', () => {
    async function setupWinningGame(ticketPrice: number, houseEdgePct: number) {
        const calledBalls = [1, 16, 31, 46, 61] // completes row 0 of default cartela

        const game = await createGame({
            status: GameStatus.IN_PROGRESS,
            pattern: PatternType.ANY_LINE,
            calledBalls,
            ticketPrice,
            houseEdgePct,
        })
        const user = await prisma.user.create({
            data: {
                username: `snap_winner_${Date.now()}`,
                phone: `+25191${Math.floor(Math.random() * 9000000 + 1000000)}`,
                passwordHash: 'hashed:pass',
                wallet: { create: { realBalance: 1000 } },
            },
        })
        const c = await createCartela(`SNAP-${Date.now()}`)
        await prisma.gameEntry.create({
            data: { gameId: game.id, userId: user.id, cartelaId: c.id },
        })
        return { game, user, c }
    }

    it('should record correct balanceBefore and balanceAfter in PRIZE_WIN transaction', async () => {
        // ticketPrice=100, houseEdge=10%, 1 entry
        // prize = 100 * 1 * (1 - 0.10) = 90
        const { game, user } = await setupWinningGame(100, 10)

        await GameService.claimBingo(user.id, game.id, (
            await prisma.gameEntry.findFirst({ where: { gameId: game.id, userId: user.id } })
        )!.cartelaId)

        const prizeTx = await prisma.transaction.findFirst({
            where: { userId: user.id, type: TransactionType.PRIZE_WIN },
        })
        expect(Number(prizeTx!.balanceBefore)).toBe(1000)
        expect(Number(prizeTx!.balanceAfter)).toBe(1090) // 1000 + 90
    })

    it('should credit commission to house wallet', async () => {
        // ticketPrice=100, houseEdge=10%, 1 entry → houseCut = 10
        const { game, user } = await setupWinningGame(100, 10)
        const cartelaId = (await prisma.gameEntry.findFirst({ where: { gameId: game.id } }))!.cartelaId

        const houseBefore = await prisma.houseWallet.findFirst()
        const balanceBefore = houseBefore ? Number(houseBefore.balance) : 0

        await GameService.claimBingo(user.id, game.id, cartelaId)

        const houseAfter = await prisma.houseWallet.findUnique({ where: { id: 'house' } })
        // houseCut = 100 * 1 * 0.10 = 10
        expect(Number(houseAfter!.balance)).toBe(balanceBefore + 10)
    })

    it('should record COMMISSION HouseTransaction with correct snapshots', async () => {
        const { game, user } = await setupWinningGame(200, 20)
        const cartelaId = (await prisma.gameEntry.findFirst({ where: { gameId: game.id } }))!.cartelaId

        await GameService.claimBingo(user.id, game.id, cartelaId)

        // houseCut = 200 * 1 * 0.20 = 40
        const htx = await prisma.houseTransaction.findFirst({
            where: { type: 'COMMISSION', gameId: game.id },
        })
        expect(htx).not.toBeNull()
        expect(Number(htx!.amount)).toBe(40)
        expect(Number(htx!.balanceAfter)).toBeGreaterThan(Number(htx!.balanceBefore))
    })

    it('should NOT credit prize to house when winner is a real user (only commission goes to house)', async () => {
        const { game, user } = await setupWinningGame(100, 10)
        const cartelaId = (await prisma.gameEntry.findFirst({ where: { gameId: game.id } }))!.cartelaId

        await GameService.claimBingo(user.id, game.id, cartelaId)

        // There should be exactly 1 house transaction (COMMISSION only, no BOT_PRIZE_WIN)
        const houseTxs = await prisma.houseTransaction.findMany({
            where: { gameId: game.id },
        })
        expect(houseTxs.length).toBe(1)
        expect(houseTxs[0].type).toBe('COMMISSION')
    })
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose game.service.extended
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/game.service.extended.test.ts
git commit -m "test(game): add PRIZE_WIN balance snapshot and house commission assertions"
```

---

## Task 7: Create HouseWalletService Tests

**Files:**
- Create: `apps/api/src/test/house-wallet.service.test.ts`

`HouseWalletService` has zero test coverage. It handles all game revenue (commissions, bot winnings, refunds issued) — critical accounting code that must be verified.

- [ ] **Step 1: Write the test file**

```typescript
// apps/api/src/test/house-wallet.service.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { HouseWalletService } from '../services/house-wallet.service'
import { prisma } from './setup'

describe('HouseWalletService', () => {
    describe('getOrCreate', () => {
        it('should create house wallet with 0 balance if it does not exist', async () => {
            const wallet = await HouseWalletService.getOrCreate()
            expect(wallet.id).toBe('house')
            expect(Number(wallet.balance)).toBe(0)
        })

        it('should return existing wallet without resetting balance', async () => {
            // Create via first call, then manually set balance
            await HouseWalletService.getOrCreate()
            await prisma.houseWallet.update({ where: { id: 'house' }, data: { balance: 500 } })

            const wallet = await HouseWalletService.getOrCreate()
            expect(Number(wallet.balance)).toBe(500) // balance preserved
        })
    })

    describe('credit', () => {
        it('should increase house balance by the credited amount', async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'Test commission')

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(100)
        })

        it('should create a HouseTransaction record', async () => {
            await HouseWalletService.credit(250, 'COMMISSION', 'Game commission', 'game-1', 'user-1')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'COMMISSION', gameId: 'game-1' },
            })
            expect(tx).not.toBeNull()
            expect(Number(tx!.amount)).toBe(250)
            expect(tx!.description).toBe('Game commission')
        })

        it('should record correct balanceBefore and balanceAfter', async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'first')
            await HouseWalletService.credit(50, 'BOT_PRIZE_WIN', 'second')

            const txs = await prisma.houseTransaction.findMany({
                orderBy: { createdAt: 'asc' },
            })

            expect(Number(txs[0].balanceBefore)).toBe(0)
            expect(Number(txs[0].balanceAfter)).toBe(100)
            expect(Number(txs[1].balanceBefore)).toBe(100)
            expect(Number(txs[1].balanceAfter)).toBe(150)
        })

        it('should handle concurrent credits without losing funds', async () => {
            await prisma.houseWallet.upsert({
                where: { id: 'house' },
                update: {},
                create: { id: 'house', balance: 0 },
            })

            // 5 concurrent credits of 20 each = expected final balance 100
            await Promise.all([
                HouseWalletService.credit(20, 'COMMISSION', 'c1'),
                HouseWalletService.credit(20, 'COMMISSION', 'c2'),
                HouseWalletService.credit(20, 'COMMISSION', 'c3'),
                HouseWalletService.credit(20, 'COMMISSION', 'c4'),
                HouseWalletService.credit(20, 'COMMISSION', 'c5'),
            ])

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(100)
        })
    })

    describe('debit', () => {
        beforeEach(async () => {
            // Seed house wallet with 1000 for debit tests
            await prisma.houseWallet.upsert({
                where: { id: 'house' },
                update: { balance: 1000 },
                create: { id: 'house', balance: 1000 },
            })
        })

        it('should decrease house balance by the debited amount', async () => {
            await HouseWalletService.debit(300, 'REFUND_ISSUED', 'Player refund')

            const balance = await HouseWalletService.getBalance()
            expect(balance.toNumber()).toBe(700)
        })

        it('should create a HouseTransaction record for the debit', async () => {
            await HouseWalletService.debit(200, 'REFUND_ISSUED', 'Refund for game-42', 'game-42')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'REFUND_ISSUED', gameId: 'game-42' },
            })
            expect(tx).not.toBeNull()
            expect(Number(tx!.amount)).toBe(200)
        })

        it('should record correct balanceBefore and balanceAfter for debit', async () => {
            await HouseWalletService.debit(400, 'REFUND_ISSUED', 'debit test')

            const tx = await prisma.houseTransaction.findFirst({
                where: { type: 'REFUND_ISSUED' },
            })
            expect(Number(tx!.balanceBefore)).toBe(1000)
            expect(Number(tx!.balanceAfter)).toBe(600)
        })
    })

    describe('getTransactions', () => {
        beforeEach(async () => {
            await HouseWalletService.credit(100, 'COMMISSION', 'c1')
            await HouseWalletService.credit(50, 'BOT_PRIZE_WIN', 'b1')
            await prisma.houseWallet.upsert({
                where: { id: 'house' },
                update: { balance: 1000 },
                create: { id: 'house', balance: 1000 },
            })
            await HouseWalletService.debit(30, 'REFUND_ISSUED', 'r1')
        })

        it('should return all transactions paginated', async () => {
            const { transactions, total } = await HouseWalletService.getTransactions(1, 10)
            expect(total).toBe(3)
            expect(transactions.length).toBe(3)
        })

        it('should filter by type', async () => {
            const { transactions, total } = await HouseWalletService.getTransactions(1, 10, 'COMMISSION')
            expect(total).toBe(1)
            expect(transactions[0].type).toBe('COMMISSION')
        })

        it('should respect pagination', async () => {
            const page1 = await HouseWalletService.getTransactions(1, 2)
            expect(page1.transactions.length).toBe(2)
            expect(page1.total).toBe(3)

            const page2 = await HouseWalletService.getTransactions(2, 2)
            expect(page2.transactions.length).toBe(1)
        })
    })

    describe('getSummary', () => {
        it('should aggregate amounts by type', async () => {
            await prisma.houseWallet.upsert({
                where: { id: 'house' },
                update: {},
                create: { id: 'house', balance: 0 },
            })
            await HouseWalletService.credit(100, 'COMMISSION', 'c1')
            await HouseWalletService.credit(200, 'COMMISSION', 'c2')
            await prisma.houseWallet.update({ where: { id: 'house' }, data: { balance: 1000 } })
            await HouseWalletService.debit(50, 'REFUND_ISSUED', 'r1')

            const summary = await HouseWalletService.getSummary()
            expect(summary.COMMISSION).toBe(300)
            expect(summary.REFUND_ISSUED).toBe(50)
            expect(summary.BOT_PRIZE_WIN).toBe(0)
        })
    })
})
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose house-wallet.service
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/house-wallet.service.test.ts
git commit -m "test(house-wallet): add comprehensive coverage for credit, debit, concurrency, and summary"
```

---

## Task 8: Fix AdminService.getStats Commission Placeholder

**Files:**
- Modify: `apps/api/src/services/admin.service.ts:7–55`

Line 53 currently returns `commission: 0, // Placeholder`. The HouseWalletService already tracks this correctly via `getSummary()`. This fix makes the admin dashboard report accurate house earnings.

- [ ] **Step 1: Write a test for the commission field**

Append to `apps/api/src/test/admin.service.test.ts`:

```typescript
describe('AdminService.getStats', () => {
    it('should return non-zero commission when house wallet has COMMISSION transactions', async () => {
        await HouseWalletService.credit(500, 'COMMISSION', 'game commission')

        const stats = await AdminService.getStats()

        expect(stats.commission).toBe(500)
    })

    it('should return 0 commission when no house transactions exist', async () => {
        const stats = await AdminService.getStats()
        expect(stats.commission).toBe(0)
    })
})
```

Also add the import at the top of admin.service.test.ts:
```typescript
import { HouseWalletService } from '../services/house-wallet.service'
import { AdminService } from '../services/admin.service'
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose admin.service
```

Expected: the `commission` test FAILS (`expected 0 to be 500`)

- [ ] **Step 3: Fix getStats in admin.service.ts**

Find in `apps/api/src/services/admin.service.ts`:

```typescript
import prisma from '../lib/prisma'
import { GameStatus, PaymentStatus, TransactionType, UserRole, NotificationType } from '@world-bingo/shared-types'
import { WalletService } from './wallet.service'
import { NotificationService } from './notification.service'
import { Decimal } from '@prisma/client/runtime/library'
```

Add `HouseWalletService` import:
```typescript
import { HouseWalletService } from './house-wallet.service'
```

Then find in `getStats()`:
```typescript
        return {
            approvedDepositSum: Number(approvedDeposits._sum.amount || 0),
            declinedDepositSum: Number(declinedDeposits._sum.amount || 0),
            approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount || 0),
            totalProfit: totalProfit,
            usersCount: totalUsers,
            gamesCount: gamesCount,
            commission: 0, // Placeholder
        }
```

Replace with:
```typescript
        const houseSummary = await HouseWalletService.getSummary()

        return {
            approvedDepositSum: Number(approvedDeposits._sum.amount || 0),
            declinedDepositSum: Number(declinedDeposits._sum.amount || 0),
            approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount || 0),
            totalProfit: totalProfit,
            usersCount: totalUsers,
            gamesCount: gamesCount,
            commission: houseSummary.COMMISSION,
        }
```

- [ ] **Step 4: Run tests to verify**

```bash
pnpm --filter @world-bingo/api test -- --reporter=verbose admin.service
```

Expected: all tests pass including the new commission tests

- [ ] **Step 5: Run full test suite**

```bash
pnpm --filter @world-bingo/api test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/admin.service.ts apps/api/src/test/admin.service.test.ts
git commit -m "fix(admin): return real commission from HouseWalletService in getStats"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Withdrawal rejection atomicity (SELECT FOR UPDATE + $transaction) → Tasks 1 & 2
- [x] Withdrawal rejection audit trail (REFUND compensation transaction) → Tasks 1 & 2
- [x] WebSocket balance push on withdrawal rejection → Tasks 1 & 2
- [x] Invalid state guard (prevent double-refund) → Tasks 1 & 2
- [x] Test setup cleanup for house/settings tables → Task 3
- [x] First-deposit bonus tests (correct credit, idempotent) → Task 4
- [x] Concurrent deposit approval test → Task 4
- [x] Bonus-first deduction logic tests → Task 5
- [x] PRIZE_WIN balance snapshot assertions → Task 6
- [x] House commission recording on game win → Task 6
- [x] HouseWalletService credit/debit/concurrency tests → Task 7
- [x] AdminService.getStats commission placeholder fix → Task 8

**No placeholders found.**

**Type consistency:** `TransactionType.REFUND`, `PaymentStatus.APPROVED`, `PaymentStatus.REJECTED`, `PaymentStatus.PENDING_REVIEW` — all used consistently from `@world-bingo/shared-types` throughout.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-01-accounting-hardening.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
