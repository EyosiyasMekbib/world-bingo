import { describe, it, expect, afterEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { CashbackFrequency } from '@world-bingo/shared-types'
import { prisma, expectInvariantClean } from './setup'
import { CashbackService, getCurrentPeriod, getPreviousPeriod } from '../services/cashback.service'

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
        // Cashback lots used to never expire. They now carry the promotion's
        // bonusValidityHours (168 by default), so a player cannot bank refunded
        // losses indefinitely — see the dedicated expiry case further down.
        expect(lot.expiresAt).not.toBeNull()
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

describe('CashbackService.runChecks — payout timing', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    async function makeDailyPromotion(overrides: Record<string, unknown>) {
        return prisma.cashbackPromotion.create({
            data: {
                name: 'Timing Cashback',
                lossThreshold: 50,
                refundType: 'FIXED',
                refundValue: 20,
                frequency: 'DAILY',
                isActive: true,
                // Live since well before the previous window opened — runChecks
                // refuses to settle a closed window a promotion was not live for.
                startsAt: new Date(Date.now() - 5 * 86400000),
                endsAt: new Date(Date.now() + 86400000),
                ...overrides,
            },
        })
    }

    it('PERIOD_CLOSE pays only once the window has ended, and pays it exactly once', async () => {
        const player = await makeUser('timingclose1', '+251900000040')
        const promotion = await makeDailyPromotion({ payoutTiming: 'PERIOD_CLOSE' })

        // A qualifying loss inside the OPEN window. The player may still win it
        // back before the day is out, so nothing may be paid yet.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED' },
        })

        const openRun = await CashbackService.runChecks()
        expect(openRun.totalDisbursed).toBe(0)
        expect(await prisma.cashbackDisbursement.count({ where: { promotionId: promotion.id } })).toBe(0)

        // The same loss, but in the window that has already closed.
        const previous = getPreviousPeriod(CashbackFrequency.DAILY)
        await prisma.transaction.create({
            data: {
                userId: player.id,
                type: 'GAME_ENTRY',
                amount: 100,
                status: 'APPROVED',
                createdAt: new Date(previous.periodStart.getTime() + 3600000),
            },
        })

        const closedRun = await CashbackService.runChecks()
        expect(closedRun.totalDisbursed).toBe(1)
        expect(closedRun.totalAmount.toNumber()).toBe(20)
        expect(closedRun.settlements).toHaveLength(1)
        expect(closedRun.settlements[0].periodStart.toISOString()).toBe(previous.periodStart.toISOString())

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { promotionId: promotion.id } })
        expect(disbursement.periodStart.toISOString()).toBe(previous.periodStart.toISOString())

        // Every later hourly run of the day re-settles the same closed window.
        // The unique (promotionId, userId, periodStart) index is what keeps that
        // from paying twice.
        const repeatRun = await CashbackService.runChecks()
        expect(repeatRun.totalDisbursed).toBe(0)
        expect(repeatRun.settlements[0].skipped).toBe(1)
        expect(await prisma.cashbackDisbursement.count({ where: { promotionId: promotion.id } })).toBe(1)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(20)
    })

    it('ON_THRESHOLD pays into the window that is still open', async () => {
        const player = await makeUser('timingthreshold1', '+251900000041')
        const promotion = await makeDailyPromotion({ payoutTiming: 'ON_THRESHOLD' })

        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED' },
        })

        const run = await CashbackService.runChecks()
        expect(run.totalDisbursed).toBe(1)

        const current = getCurrentPeriod(CashbackFrequency.DAILY)
        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { promotionId: promotion.id } })
        expect(disbursement.periodStart.toISOString()).toBe(current.periodStart.toISOString())
    })

    it('PERIOD_CLOSE settles only the part of the window the promotion was still live for', async () => {
        const player = await makeUser('timingended1', '+251900000042')
        const previous = getPreviousPeriod(CashbackFrequency.DAILY)

        // Dies six hours into the window this run settles: live for the first
        // half of it, over for the rest. A PERIOD_CLOSE promotion is settled
        // after its own endsAt by design, which is what exposes the gap.
        const promotion = await makeDailyPromotion({
            payoutTiming: 'PERIOD_CLOSE',
            refundType: 'PERCENTAGE',
            refundValue: 50,
            endsAt: new Date(previous.periodStart.getTime() + 6 * 3600000),
        })

        await prisma.transaction.create({
            data: {
                userId: player.id, type: 'GAME_ENTRY', amount: 60, status: 'APPROVED',
                createdAt: new Date(previous.periodStart.getTime() + 3600000),
            },
        })
        // Played after the promotion ended — it advertised no cashback for this.
        await prisma.transaction.create({
            data: {
                userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED',
                createdAt: new Date(previous.periodStart.getTime() + 10 * 3600000),
            },
        })

        const run = await CashbackService.runChecks()
        expect(run.totalDisbursed).toBe(1)
        expect(run.totalAmount.toNumber()).toBe(30) // 50% of the 60 lost while live, not of 160

        // Only the LOSS window is clamped: the disbursement stays keyed to the
        // canonical window start, which is what keeps the run idempotent.
        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { promotionId: promotion.id } })
        expect(disbursement.periodStart.toISOString()).toBe(previous.periodStart.toISOString())

        const repeatRun = await CashbackService.runChecks()
        expect(repeatRun.totalDisbursed).toBe(0)
        expect(await prisma.cashbackDisbursement.count({ where: { promotionId: promotion.id } })).toBe(1)
    })

    it('ignores play from before a promotion started, still keying the disbursement to the window start', async () => {
        const player = await makeUser('timingstarted1', '+251900000043')
        const previous = getPreviousPeriod(CashbackFrequency.DAILY)

        // Born six hours into the window. runChecks deliberately skips a window
        // a promotion was not live at the start of, so the symmetric start clamp
        // is exercised through checkAndDisburse, which admin settlement also uses.
        const promotion = await makeDailyPromotion({
            payoutTiming: 'PERIOD_CLOSE',
            refundType: 'PERCENTAGE',
            refundValue: 50,
            startsAt: new Date(previous.periodStart.getTime() + 6 * 3600000),
        })

        await prisma.transaction.create({
            data: {
                userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED',
                createdAt: new Date(previous.periodStart.getTime() + 3600000),
            },
        })
        await prisma.transaction.create({
            data: {
                userId: player.id, type: 'GAME_ENTRY', amount: 60, status: 'APPROVED',
                createdAt: new Date(previous.periodStart.getTime() + 9 * 3600000),
            },
        })

        const result = await CashbackService.checkAndDisburse(promotion.id, previous.periodStart, previous.periodEnd)
        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(30)

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { promotionId: promotion.id } })
        expect(disbursement.periodStart.toISOString()).toBe(previous.periodStart.toISOString())
    })
})

describe('CashbackService.checkAndDisburse — caps, budgets and expiry', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('clamps a payout to maxPayoutPerPlayer', async () => {
        const player = await makeUser('cashbackcapped1', '+251900000042')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Capped Cashback', lossThreshold: 50, refundType: 'PERCENTAGE', refundValue: 50,
                frequency: 'DAILY', isActive: true, maxPayoutPerPlayer: 75,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // 400 lost at 50% = 200 uncapped, which the 75 cap must cut down.
        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 400, status: 'APPROVED' },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(75)

        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { userId: player.id } })
        expect(new Decimal(disbursement.amount).toNumber()).toBe(75)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(75)
    })

    it('stops at periodBudget, paying the biggest losses first and reporting the unpaid tail', async () => {
        const bigLoser = await makeUser('cashbackbudgetbig', '+251900000043')
        const smallLoser = await makeUser('cashbackbudgetsmall', '+251900000044')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Budgeted Cashback', lossThreshold: 50, refundType: 'PERCENTAGE', refundValue: 50,
                frequency: 'DAILY', isActive: true, periodBudget: 150,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        // Payouts would be 150 and 50 — together 200, over the 150 budget.
        await prisma.transaction.create({
            data: { userId: bigLoser.id, type: 'GAME_ENTRY', amount: 300, status: 'APPROVED' },
        })
        await prisma.transaction.create({
            data: { userId: smallLoser.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED' },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(150)
        // Surfaced, not swallowed: a caller that only reads `disbursed` would
        // otherwise read a truncated run as "everyone was paid".
        expect(result.budgetSkipped).toBe(1)

        const paid = await prisma.cashbackDisbursement.findMany({ where: { promotionId: promotion.id } })
        expect(paid).toHaveLength(1)
        expect(paid[0].userId).toBe(bigLoser.id)

        const smallWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: smallLoser.id } })
        expect(new Decimal(smallWallet.bonusBalance).toNumber()).toBe(0)

        // A later run must not quietly top the budget back up either.
        const rerun = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(rerun.disbursed).toBe(0)
        expect(rerun.budgetSkipped).toBe(1)
    })

    it('grants the lot with an expiry bonusValidityHours after the payout', async () => {
        const player = await makeUser('cashbackexpiry1', '+251900000045')

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Expiring Cashback', lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true, bonusValidityHours: 24,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        await prisma.transaction.create({
            data: { userId: player.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED' },
        })

        const before = Date.now()
        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(lot.expiresAt).not.toBeNull()
        const expiresIn = (lot.expiresAt as Date).getTime() - before
        expect(expiresIn).toBeGreaterThan(23.9 * 3600000)
        expect(expiresIn).toBeLessThan(24.1 * 3600000)
    })
})

describe('CashbackService.getNetLossByUser — what counts as a real loss', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    async function makeUnscopedPromotion(name: string, overrides: Record<string, unknown> = {}) {
        return prisma.cashbackPromotion.create({
            data: {
                name, lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
                ...overrides,
            },
        })
    }

    async function makeGame(suffix: string) {
        return prisma.game.create({
            data: {
                title: `Loss Game ${suffix}`, ticketPrice: 10, maxPlayers: 70, minPlayers: 2,
                houseEdgePct: 10, pattern: 'ANY_LINE', status: 'CANCELLED', calledBalls: [],
            },
        })
    }

    it('does not count an entry the player was refunded for when the game was cancelled', async () => {
        const refunded = await makeUser('lossrefunded1', '+251900000050')
        const control = await makeUser('losscontrol1', '+251900000051')
        const cancelledGame = await makeGame('cancelled')
        const playedGame = await makeGame('played')

        const promotion = await makeUnscopedPromotion('Refund Aware')

        // A cancelled game leaves the GAME_ENTRY row APPROVED and books the money
        // back as a separate REFUND row against the same gameId.
        await prisma.transaction.create({
            data: { userId: refunded.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED', referenceId: cancelledGame.id, balanceBefore: 100, balanceAfter: 0 },
        })
        await prisma.transaction.create({
            data: { userId: refunded.id, type: 'REFUND', amount: 100, status: 'APPROVED', referenceId: cancelledGame.id, balanceBefore: 0, balanceAfter: 100 },
        })

        // The control player really did lose 100 — and has a withdrawal reversal
        // in the same window, which is also a REFUND row but references a
        // transaction, not a game, so it must not wipe out their loss.
        await prisma.transaction.create({
            data: { userId: control.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED', referenceId: playedGame.id, balanceBefore: 100, balanceAfter: 0 },
        })
        const withdrawal = await prisma.transaction.create({
            data: { userId: control.id, type: 'WITHDRAWAL', amount: 500, status: 'REJECTED' },
        })
        await prisma.transaction.create({
            data: { userId: control.id, type: 'REFUND', amount: 500, status: 'APPROVED', referenceId: withdrawal.id, balanceBefore: 0, balanceAfter: 500 },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(refunded.id) ?? 0).toNumber()).toBe(0)
        expect(new Decimal(netLoss.get(control.id) ?? 0).toNumber()).toBe(100)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(1)

        const paid = await prisma.cashbackDisbursement.findMany({ where: { promotionId: promotion.id } })
        expect(paid.map((p) => p.userId)).toEqual([control.id])
    })

    it('counts only the real-balance part of a bonus-funded entry, so bonus cannot recycle into bonus', async () => {
        const bonusOnly = await makeUser('lossbonusonly1', '+251900000052')
        const mixed = await makeUser('lossmixed1', '+251900000053')

        const promotion = await makeUnscopedPromotion('Bonus Aware', { refundType: 'PERCENTAGE', refundValue: 50 })

        // joinGame with spendAccount = 'BONUS': the whole 100 came out of the
        // bonus wallet, which the snapshot columns record.
        await prisma.transaction.create({
            data: {
                userId: bonusOnly.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED',
                balanceBefore: 0, balanceAfter: 0, bonusBalanceBefore: 100, bonusBalanceAfter: 0,
            },
        })

        // 20 of this 100 stake came from bonus, so only 80 is a real loss —
        // a 50% refund on it is 40, not 50.
        await prisma.transaction.create({
            data: {
                userId: mixed.id, type: 'GAME_ENTRY', amount: 100, status: 'APPROVED',
                balanceBefore: 80, balanceAfter: 0, bonusBalanceBefore: 20, bonusBalanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(bonusOnly.id) ?? 0).toNumber()).toBe(0)
        expect(new Decimal(netLoss.get(mixed.id) ?? 0).toNumber()).toBe(80)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(40)

        const bonusOnlyWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: bonusOnly.id } })
        expect(new Decimal(bonusOnlyWallet.bonusBalance).toNumber()).toBe(0)
    })

    it('counts provider-game losses for an unscoped promotion, which is what site-wide means', async () => {
        const player = await makeUser('lossprovider1', '+251900000054')
        const promotion = await makeUnscopedPromotion('Site Wide')

        // No bingo play at all: this loss exists only in the provider ledger.
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: player.id, providerId: 'provider-unscoped-netloss',
                transactionId: `bet-unscoped-${Date.now()}`, gameCode: 'SLOT-1',
                type: 'BET', status: 'COMPLETED', amount: -100, balanceBefore: 100, balanceAfter: 0,
            },
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(player.id) ?? 0).toNumber()).toBe(100)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(20)
    })

    /**
     * Writes a provider callback exactly as the three wallet services do: the
     * third_party_transactions row (whose balance columns are the COMBINED
     * real+bonus total) plus the paired wallet-audit row keyed on
     * referenceId = the provider transactionId, which is the only row carrying
     * the real/bonus split. `pairedType: null` stands for pre-pairing data.
     */
    async function writeProviderPlay(opts: {
        userId: string
        transactionId: string
        tptType: 'BET' | 'ROLLBACK'
        tptStatus: 'COMPLETED' | 'ROLLED_BACK'
        amount: number
        pairedType: 'TP_BET' | 'TP_ROLLBACK' | null
        bonusBefore?: number
        bonusAfter?: number
        /** null stands for Atlas-V, whose game_code is optional on every call. */
        gameCode?: string | null
    }) {
        await prisma.thirdPartyTransaction.create({
            data: {
                userId: opts.userId,
                providerId: 'provider-real-loss-suite',
                transactionId: opts.transactionId,
                gameCode: opts.gameCode === undefined ? 'SLOT-1' : opts.gameCode,
                type: opts.tptType,
                status: opts.tptStatus,
                amount: opts.amount,
                balanceBefore: 0,
                balanceAfter: 0,
            },
        })
        if (!opts.pairedType) return
        await prisma.transaction.create({
            data: {
                userId: opts.userId,
                type: opts.pairedType,
                amount: Math.abs(opts.amount),
                status: 'APPROVED',
                referenceId: opts.transactionId,
                balanceBefore: 0,
                balanceAfter: 0,
                bonusBalanceBefore: opts.bonusBefore ?? 0,
                bonusBalanceAfter: opts.bonusAfter ?? 0,
            },
        })
    }

    it('counts only the real-balance part of a bonus-funded provider bet, so slots cannot recycle bonus into bonus', async () => {
        const bonusOnly = await makeUser('lossprovbonus1', '+251900000055')
        const mixed = await makeUser('lossprovmixed1', '+251900000056')
        const legacy = await makeUser('lossprovlegacy1', '+251900000057')

        const promotion = await makeUnscopedPromotion('Provider Bonus Aware', { refundType: 'PERCENTAGE', refundValue: 50 })

        // spendAccount = 'BONUS': the whole 100 stake came out of the bonus
        // wallet, so no real money was lost and no cashback may be earned.
        await writeProviderPlay({
            userId: bonusOnly.id, transactionId: 'tp-bonus-only', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -100, pairedType: 'TP_BET', bonusBefore: 100, bonusAfter: 0,
        })
        // 30 of this 100 came from bonus → 70 real, a 50% refund of 35.
        await writeProviderPlay({
            userId: mixed.id, transactionId: 'tp-mixed', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -100, pairedType: 'TP_BET', bonusBefore: 30, bonusAfter: 0,
        })
        // No paired audit row at all (data predating the pairing) still counts as
        // wholly real, which is how this ledger was read before the split.
        await writeProviderPlay({
            userId: legacy.id, transactionId: 'tp-legacy', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -100, pairedType: null,
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(bonusOnly.id) ?? 0).toNumber()).toBe(0)
        expect(new Decimal(netLoss.get(mixed.id) ?? 0).toNumber()).toBe(70)
        expect(new Decimal(netLoss.get(legacy.id) ?? 0).toNumber()).toBe(100)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(2)
        expect(result.total.toNumber()).toBe(85) // 35 + 50, nothing for the bonus-only player

        const paid = await prisma.cashbackDisbursement.findMany({ where: { promotionId: promotion.id } })
        expect(paid.map((p) => p.userId).sort()).toEqual([legacy.id, mixed.id].sort())

        const bonusOnlyWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: bonusOnly.id } })
        expect(new Decimal(bonusOnlyWallet.bonusBalance).toNumber()).toBe(0)
    })

    it('leaves a cancelled provider bet out entirely, so it is neither a loss nor a win', async () => {
        const cancelledOnly = await makeUser('lossprovrb1', '+251900000058')
        const alsoLost = await makeUser('lossprovrb2', '+251900000059')

        const promotion = await makeUnscopedPromotion('Rollback Aware')

        // A rollback flips the original BET to ROLLED_BACK and books a
        // compensating ROLLBACK row for the same money across the same accounts,
        // so the pair nets to zero and both halves are dropped. Keeping only one
        // side is the bug either way round: the credit alone reads as a win, the
        // debit alone bills a stake that was handed straight back.
        await writeProviderPlay({
            userId: cancelledOnly.id, transactionId: 'tp-rb-bet', tptType: 'BET', tptStatus: 'ROLLED_BACK',
            amount: -60, pairedType: 'TP_BET',
        })
        await writeProviderPlay({
            userId: cancelledOnly.id, transactionId: 'tp-rb-cancel', tptType: 'ROLLBACK', tptStatus: 'COMPLETED',
            amount: 60, pairedType: 'TP_ROLLBACK',
        })

        // A genuine 100 loss alongside a rolled-back 60 bet: the reversal must
        // not eat into the loss the player really took.
        await writeProviderPlay({
            userId: alsoLost.id, transactionId: 'tp-real-bet', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -100, pairedType: 'TP_BET',
        })
        await writeProviderPlay({
            userId: alsoLost.id, transactionId: 'tp-rb2-bet', tptType: 'BET', tptStatus: 'ROLLED_BACK',
            amount: -60, pairedType: 'TP_BET',
        })
        await writeProviderPlay({
            userId: alsoLost.id, transactionId: 'tp-rb2-cancel', tptType: 'ROLLBACK', tptStatus: 'COMPLETED',
            amount: 60, pairedType: 'TP_ROLLBACK',
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(cancelledOnly.id) ?? 0).toNumber()).toBe(0)
        expect(new Decimal(netLoss.get(alsoLost.id) ?? 0).toNumber()).toBe(100)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(1)
        expect(result.total.toNumber()).toBe(20)

        const paid = await prisma.cashbackDisbursement.findMany({ where: { promotionId: promotion.id } })
        expect(paid.map((p) => p.userId)).toEqual([alsoLost.id])
    })

    it('drops a cancelled bet from a game-scoped promotion even when the rollback row names no game', async () => {
        // Atlas-V's game_code is optional on a cancel, so the ROLLBACK row it
        // writes can carry a NULL gameCode while the bet it reverses names the
        // scoped game. A (providerId, gameCode) IN (...) test never matches a
        // NULL, so scoping the two halves independently kept the debit and threw
        // away the credit — billing a stake the player got back in full.
        const player = await makeUser('lossprovscoped1', '+251900000066')

        const promotion = await makeUnscopedPromotion('Scoped Rollback Aware', {
            providerGameKeys: ['provider-real-loss-suite:SLOT-1'],
        })

        await writeProviderPlay({
            userId: player.id, transactionId: 'tp-scoped-bet', tptType: 'BET', tptStatus: 'ROLLED_BACK',
            amount: -80, pairedType: 'TP_BET',
        })
        await writeProviderPlay({
            userId: player.id, transactionId: 'tp-scoped-cancel', tptType: 'ROLLBACK', tptStatus: 'COMPLETED',
            amount: 80, pairedType: 'TP_ROLLBACK', gameCode: null,
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const netLoss = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(netLoss.get(player.id) ?? 0).toNumber()).toBe(0)

        const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
        expect(result.disbursed).toBe(0)
    })

    it('returns one player when asked for one, so a progress bar never scans the player base', async () => {
        const asking = await makeUser('lossoneplayer1', '+251900000067')
        const other = await makeUser('lossoneplayer2', '+251900000068')

        const promotion = await makeUnscopedPromotion('Single Player Scope')

        await writeProviderPlay({
            userId: asking.id, transactionId: 'tp-single-mine', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -70, pairedType: 'TP_BET',
        })
        // Both a bingo row and a provider row, because the predicate has to be
        // bound in BOTH CTEs — binding one leaks the other's site-wide total.
        await prisma.transaction.create({
            data: { userId: other.id, type: 'GAME_ENTRY', amount: 5000, status: 'APPROVED' },
        })
        await writeProviderPlay({
            userId: other.id, transactionId: 'tp-single-theirs', tptType: 'BET', tptStatus: 'COMPLETED',
            amount: -5000, pairedType: 'TP_BET',
        })

        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
        const scoped = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd, asking.id)
        expect([...scoped.keys()]).toEqual([asking.id])
        expect(new Decimal(scoped.get(asking.id) ?? 0).toNumber()).toBe(70)

        const everyone = await CashbackService.getNetLossByUser(promotion, periodStart, periodEnd)
        expect(new Decimal(everyone.get(other.id) ?? 0).toNumber()).toBe(10000)
    })
})

describe('CashbackService.previewQualifiers', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('projects the open period with the per-player cap applied but the budget ignored', async () => {
        const first = await makeUser('previewbig1', '+251900000060')
        const second = await makeUser('previewmid1', '+251900000061')
        const third = await makeUser('previewsmall1', '+251900000062')
        const belowThreshold = await makeUser('previewbelow1', '+251900000063')
        const bot = await prisma.user.create({
            data: {
                username: 'bot_tpreview', phone: '+251900000064', passwordHash: 'hashed:pass',
                role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } },
            },
        })

        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Preview Cashback', lossThreshold: 50, refundType: 'PERCENTAGE', refundValue: 50,
                frequency: 'DAILY', isActive: true, maxPayoutPerPlayer: 80, periodBudget: 10,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        for (const [user, amount] of [[first, 300], [second, 200], [third, 60], [belowThreshold, 40], [bot, 900]] as const) {
            await prisma.transaction.create({
                data: { userId: user.id, type: 'GAME_ENTRY', amount, status: 'APPROVED' },
            })
        }

        const preview = await CashbackService.previewQualifiers(promotion.id)
        const current = getCurrentPeriod(CashbackFrequency.DAILY)

        expect(preview.periodStart.toISOString()).toBe(current.periodStart.toISOString())
        // The 40-loss player is under the threshold and the bot never qualifies.
        expect(preview.players).toBe(3)
        // 150 and 100 both clamp to the 80 cap; 30 is under it. The 10 budget is
        // deliberately NOT applied — the admin screen shows the over-budget delta.
        expect(preview.projectedTotal.toNumber()).toBe(190)
        expect(preview.largest.toNumber()).toBe(80)
        expect(preview.top.map((t) => t.username)).toEqual([first.username, second.username, third.username])
        expect(preview.top[0].netLoss.toNumber()).toBe(300)
        expect(preview.top[2].payout.toNumber()).toBe(30)

        // A preview pays nobody.
        expect(await prisma.cashbackDisbursement.count({ where: { promotionId: promotion.id } })).toBe(0)
    })

    it('caps the top list at 5 players', async () => {
        const promotion = await prisma.cashbackPromotion.create({
            data: {
                name: 'Preview Top', lossThreshold: 50, refundType: 'FIXED', refundValue: 20,
                frequency: 'DAILY', isActive: true,
                startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
            },
        })

        for (let i = 0; i < 7; i++) {
            const player = await makeUser(`previewmany${i}`, `+2519000007${i}0`)
            await prisma.transaction.create({
                data: { userId: player.id, type: 'GAME_ENTRY', amount: 100 + i, status: 'APPROVED' },
            })
        }

        const preview = await CashbackService.previewQualifiers(promotion.id)
        expect(preview.players).toBe(7)
        expect(preview.top).toHaveLength(5)
        // Biggest loss first.
        expect(preview.top[0].netLoss.toNumber()).toBe(106)
        expect(preview.projectedTotal.toNumber()).toBe(140)
    })
})
