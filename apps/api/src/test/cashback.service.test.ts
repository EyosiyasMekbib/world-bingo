import { describe, it, expect, afterEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { CashbackFrequency } from '@world-bingo/shared-types'
import { prisma, expectInvariantClean } from './setup'
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
    afterEach(async () => {
        await expectInvariantClean()
    })

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

    it('locks the wallet so two concurrent disbursements to the same player chain their before/after balances correctly', async () => {
        // BonusService.grant() reads bonusBalance with a plain, unlocked SELECT —
        // it assumes the CALLER already holds a FOR UPDATE lock on the wallet row
        // (the Global Constraint every other BonusService caller follows, e.g.
        // game.service.ts's joinGame). Without that lock here, two disbursements
        // racing for the SAME player can both read the pre-grant balance and each
        // record a `bonusBalanceBefore` of 0 in their CASHBACK_BONUS audit row —
        // even though the wallet's actual increments are individually atomic and
        // the FINAL balance is correct. Locked, they serialize: whichever commits
        // second sees the first one's committed balance as its own "before".
        const player = await makeUser('cashbackconcurrent', '+251900000023')

        const promoA = await prisma.cashbackPromotion.create({
            data: {
                name: 'Concurrent A', lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })
        const promoB = await prisma.cashbackPromotion.create({
            data: {
                name: 'Concurrent B', lossThreshold: 50, refundType: 'FIXED', refundValue: 30,
                frequency: 'DAILY', isActive: true,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED' },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)

        await Promise.all([
            CashbackService.checkAndDisburse(promoA.id, periodStart, periodEnd),
            CashbackService.checkAndDisburse(promoB.id, periodStart, periodEnd),
        ])

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(50)

        const rows = await prisma.transaction.findMany({
            where: { userId: player.id, type: 'CASHBACK_BONUS' },
        })
        expect(rows).toHaveLength(2)

        const sorted = [...rows].sort(
            (a, b) => Number(a.bonusBalanceBefore) - Number(b.bonusBalanceBefore),
        )
        expect(Number(sorted[0].bonusBalanceBefore)).toBe(0)
        // The second row's "before" must equal the first row's "after" — not
        // ALSO 0, which is what an unlocked, racing read would produce.
        expect(Number(sorted[1].bonusBalanceBefore)).toBe(Number(sorted[0].bonusBalanceAfter))
        expect(Number(sorted[1].bonusBalanceAfter)).toBe(50)
    })
})

describe('CashbackService.checkAndDisburse — game scoping', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    async function makeTemplate(suffix: string) {
        return prisma.gameTemplate.create({
            data: {
                title: `Scoped Template ${suffix}`,
                ticketPrice: 10,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            },
        })
    }

    async function makeGameForTemplate(templateId: string | null, suffix: string) {
        return prisma.game.create({
            data: {
                title: `Scoped Game ${suffix}`,
                ticketPrice: 10,
                maxPlayers: 70,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
                status: 'COMPLETED',
                calledBalls: [],
                templateId,
            },
        })
    }

    async function makeProviderGame(suffix: string) {
        const provider = await prisma.gameProvider.create({
            data: { code: `prov-scope-${suffix}-${Date.now()}`, name: 'Test Provider', status: 'ACTIVE', apiBaseUrl: '', currency: 'ETB', config: {} },
        })
        const vendor = await prisma.gameVendor.create({
            data: { providerId: provider.id, code: 'V1', name: 'Test Vendor' },
        })
        const game = await prisma.providerGame.create({
            data: {
                providerId: provider.id,
                vendorId: vendor.id,
                gameCode: `GAME-${suffix}`,
                gameName: `Provider Game ${suffix}`,
                categoryCode: 'SLOTS',
                languageCodes: ['en'],
                platformCodes: ['WEB'],
                currencyCodes: ['ETB'],
            },
        })
        return { provider, game }
    }

    it('only counts losses on the scoped bingo template, ignoring losses on other games', async () => {
        const player = await makeUser('scopedbingo1', '+251900000030')
        const inScopeTemplate = await makeTemplate('in')
        const outOfScopeTemplate = await makeTemplate('out')
        const inScopeGame = await makeGameForTemplate(inScopeTemplate.id, 'in')
        const outOfScopeGame = await makeGameForTemplate(outOfScopeTemplate.id, 'out')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Template Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true, templateIds: [inScopeTemplate.id],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope loss: 100 wagered, 0 won.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED', referenceId: inScopeGame.id },
        })
        // Out-of-scope loss: 500 wagered — must NOT count toward this promotion.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 500, status: 'APPROVED', referenceId: outOfScopeGame.id },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(20)

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { userId: player.id, promotionId: promotion.id } })
        expect(new Decimal(disbursement.amount).toNumber()).toBe(20)
    })

    it('only counts losses on the scoped provider game', async () => {
        const player = await makeUser('scopedprovider1', '+251900000031')
        const { provider, game } = await makeProviderGame('a')
        const { game: otherGame } = await makeProviderGame('b')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Provider Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 15,
                frequency: 'DAILY', isActive: true, providerGameKeys: [`${provider.id}:${game.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope: net loss of 100 (bet 100, no win).
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-a`,
                gameCode: game.gameCode, type: 'BET', status: 'COMPLETED', amount: -100,
                balanceBefore: 0, balanceAfter: 0,
            },
        })
        // Out-of-scope: a big loss on a different provider game — must NOT count.
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-b`,
                gameCode: otherGame.gameCode, type: 'BET', status: 'COMPLETED', amount: -900,
                balanceBefore: 0, balanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(15)
    })

    it('sums losses across a mixed bingo-template + provider-game scope', async () => {
        const player = await makeUser('scopedmixed1', '+251900000032')
        const template = await makeTemplate('mixed')
        const bingoGame = await makeGameForTemplate(template.id, 'mixed')
        const { provider, game: providerGame } = await makeProviderGame('mixed')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Mixed Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 25,
                frequency: 'DAILY', isActive: true,
                templateIds: [template.id], providerGameKeys: [`${provider.id}:${providerGame.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // 30 lost on bingo + 30 lost on the provider game = 60 total, clears the 50 threshold.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 30, status: 'APPROVED', referenceId: bingoGame.id },
        })
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: provider.id, transactionId: `bet-${Date.now()}-mixed`,
                gameCode: providerGame.gameCode, type: 'BET', status: 'COMPLETED', amount: -30,
                balanceBefore: 0, balanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(25)
    })

    it('does not disburse when the scoped loss alone is below threshold, even if site-wide loss would clear it', async () => {
        const player = await makeUser('scopedbelow1', '+251900000033')
        const inScopeTemplate = await makeTemplate('below-in')
        const outOfScopeTemplate = await makeTemplate('below-out')
        const inScopeGame = await makeGameForTemplate(inScopeTemplate.id, 'below-in')
        const outOfScopeGame = await makeGameForTemplate(outOfScopeTemplate.id, 'below-out')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Threshold Scoped', lossThreshold: 100, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true, templateIds: [inScopeTemplate.id],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // In-scope loss is only 40 — below the 100 threshold.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 40, status: 'APPROVED', referenceId: inScopeGame.id },
        })
        // Out-of-scope loss of 200 would clear the threshold site-wide, but must be ignored.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 200, status: 'APPROVED', referenceId: outOfScopeGame.id },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(0)
        expect(result.skipped).toBe(0)
        const disbursement = await prisma.cashbackDisbursement.findFirst({ where: { userId: player.id, promotionId: promotion.id } })
        expect(disbursement).toBeNull()
    })

    it('listPromotions resolves scoped template and provider game ids into display names', async () => {
        const template = await makeTemplate('listed')
        const { provider, game } = await makeProviderGame('listed')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Listed Scoped', lossThreshold: 50, refundType: 'FIXED', refundValue: 10,
                frequency: 'DAILY', isActive: true,
                templateIds: [template.id], providerGameKeys: [`${provider.id}:${game.gameCode}`],
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        const list = await CashbackService.listPromotions()
        const found = list.find((p) => p.id === promotion.id)

        expect(found?.scopedGameNames).toEqual([template.title, game.gameName])
    })
})
