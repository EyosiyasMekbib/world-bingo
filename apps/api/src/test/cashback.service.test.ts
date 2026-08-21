import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { CashbackFrequency } from '@world-bingo/shared-types'
import { prisma } from './setup'
import { CashbackService, getCurrentPeriod } from '../services/cashback.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
        },
    })
}

describe('CashbackService.checkAndDisburse', () => {
    it('disburses cashback as a BonusGrant lot', async () => {
        const player = await makeUser('cashbackplayer1', '+251900000021')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Daily Cashback',
                lossThreshold: 50,
                refundType: 'FIXED',
                refundValue: 20,
                frequency: 'DAILY',
                isActive: true,
                startsAt: new Date(Date.now() - 1000),
                endsAt: new Date(Date.now() + 86400000),
            },
        })

        // Qualifying loss: 100 wagered, 0 won, within today's DAILY window.
        await prisma.transaction.create({
            data: {
                userId: player.id,
                type: 'GAME_ENTRY',
                amount: 100,
                status: 'APPROVED',
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.skipped).toBe(0)
        expect(result.total.toNumber()).toBe(20)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(lot.ruleId).toBeNull()
        expect(lot.expiresAt).toBeNull()
        expect(new Decimal(lot.remaining).toNumber()).toBe(20)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(20)
    })

    it('rounds a PERCENTAGE payout down to 2 decimal places, so the disbursement, the ledger and the wallet never drift', async () => {
        const player = await makeUser('cashbackpercent1', '+251900000022')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Percent Cashback',
                lossThreshold: 50,
                refundType: 'PERCENTAGE',
                refundValue: 33.33,
                frequency: 'DAILY',
                isActive: true,
                startsAt: new Date(Date.now() - 1000),
                endsAt: new Date(Date.now() + 86400000),
            },
        })

        // netLoss = 100.05, refundValue = 33.33% → raw payout = 33.346665, whose
        // third decimal digit (6) rounds UP to 33.35 under Postgres's default
        // half-up cast into a Decimal(12,2) column — it must instead round DOWN
        // to 33.34 everywhere: the disbursement row, the CASHBACK_BONUS ledger
        // row, the BonusGrant lot, and the wallet's cached balance.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100.05, status: 'APPROVED' },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(33.34)

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { userId: player.id } })
        expect(new Decimal(disbursement.amount).toNumber()).toBe(33.34)

        const txn = await prisma.transaction.findFirstOrThrow({
            where: { userId: player.id, type: 'CASHBACK_BONUS' },
        })
        expect(new Decimal(txn.amount).toNumber()).toBe(33.34)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(new Decimal(lot.remaining).toNumber()).toBe(33.34)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(33.34)
    })
})
