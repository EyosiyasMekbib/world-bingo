import { describe, it, expect, afterEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma, expectInvariantClean } from './setup'
import { DepositBonusService } from '../services/deposit-bonus.service'
import { BonusRuleService } from '../services/bonus-rule.service'

async function makeUser(username: string, phone: string, realBalance: number) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance, bonusBalance: 0 } },
        },
    })
}

async function approvedDeposit(userId: string, amount: number, at: Date) {
    return prisma.transaction.create({
        data: { userId, type: 'DEPOSIT', amount, status: 'APPROVED', createdAt: at },
    })
}

async function dailyRule(name: string) {
    return BonusRuleService.create({
        name, type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
        rewardValue: 50, validityHours: 24, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
    })
}

/**
 * A deposit-rule grant used to move `bonusBalance` with nothing in the ledger
 * to explain it — the balance changed and no transaction row said why. These
 * tests pin the audit row down, including its idempotency: the ledger must
 * follow the grant exactly, never gaining a duplicate row from a retried
 * approval of the same bucket.
 */
describe('DepositBonusService.evaluateAndGrant — ledger row', () => {
    afterEach(expectInvariantClean)

    it('writes exactly one DAILY_DEPOSIT_BONUS transaction with both balance snapshot pairs', async () => {
        const user = await makeUser('depledger1', '+251900003001', 600)
        const rule = await dailyRule('Daily ledger')
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        const result = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))

        expect(result.daily).toHaveLength(1)
        expect(result.daily[0].name).toBe('Daily ledger')
        expect(result.daily[0].expiresAt.toISOString()).toBe(new Date(day.getTime() + 24 * 3_600_000).toISOString())

        const rows = await prisma.transaction.findMany({ where: { userId: user.id, type: 'DAILY_DEPOSIT_BONUS' } })
        expect(rows).toHaveLength(1)
        const row = rows[0]
        expect(new Decimal(row.amount).toNumber()).toBe(50)
        expect(row.status).toBe('APPROVED')
        expect(row.referenceId).toBe(rule.id)
        expect(row.note).toContain('Daily ledger')
        // Real balance is untouched by a bonus grant: both snapshots hold the
        // balance as it stands, and neither is the bonus figure.
        expect(new Decimal(row.balanceBefore!).toNumber()).toBe(600)
        expect(new Decimal(row.balanceAfter!).toNumber()).toBe(600)
        expect(new Decimal(row.bonusBalanceBefore!).toNumber()).toBe(0)
        expect(new Decimal(row.bonusBalanceAfter!).toNumber()).toBe(50)

        // Provenance lands on the lot itself, not just the ledger row.
        const grant = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: user.id } })
        expect(grant.source).toBe('DAILY_DEPOSIT')
    })

    it('a second evaluation of the same bucket writes no second ledger row', async () => {
        const user = await makeUser('depledger2', '+251900003002', 600)
        await dailyRule('Daily ledger idem')
        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)

        await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))
        const second = await prisma.$transaction((tx) => DepositBonusService.evaluateAndGrant(tx, user.id, day, day))

        expect(second.daily).toHaveLength(0)
        const rows = await prisma.transaction.findMany({ where: { userId: user.id, type: 'DAILY_DEPOSIT_BONUS' } })
        expect(rows).toHaveLength(1)
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)
    })
})
