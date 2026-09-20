/**
 * HTTP-level coverage for the admin promotion and bonus-lot routes, all of it
 * about money that is already earned: re-pricing a closed cashback window,
 * ending a promotion that still owes one, the expiry an admin grant is given,
 * and extending a single lot's deadline.
 *
 * Mirrors admin-adjust-balance.test.ts's convention: build a bare Fastify
 * instance, stub the auth decorators adminRoutes' preValidation hooks call
 * (they just set request.user — no real JWT is verified), register adminRoutes,
 * and drive it with app.inject.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma, expectInvariantClean } from './setup'
import { CashbackFrequency } from '@world-bingo/shared-types'

vi.mock('../lib/redis', () => ({
    default: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
    },
}))
vi.mock('../services/notification.service', () => ({
    NotificationService: {
        pushWalletUpdate: vi.fn(),
        create: vi.fn().mockResolvedValue(undefined),
    },
}))
vi.mock('../services/referral.service', () => ({
    ReferralService: { processFirstDepositBonus: vi.fn().mockResolvedValue(undefined) },
}))

import adminRoutes from '../routes/admin/index'
import { CashbackService, getPreviousPeriod } from '../services/cashback.service'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const rnd = () => Math.random().toString(36).slice(2, 10)

async function buildApp(adminId: string) {
    const app = Fastify({ logger: false })
    const setUser = async (request: any) => {
        request.user = { id: adminId, role: 'ADMIN' }
    }
    app.decorate('authenticate', setUser)
    app.decorate('requireAdmin', setUser)
    app.decorate('requireAdminOrClerk', setUser)
    app.decorate('requireSuperAdmin', setUser)
    await app.register(adminRoutes, { prefix: '/admin' })
    await app.ready()
    return app
}

function mk(role: 'PLAYER' | 'ADMIN', bonusBalance = 0) {
    return prisma.user.create({
        data: {
            username: `promo_${role}_${rnd()}`,
            phone: `09${Math.floor(10000000 + Math.random() * 89999999)}`,
            passwordHash: 'hashed:x',
            role,
            wallet: { create: { realBalance: 0, bonusBalance } },
        },
    })
}

/**
 * A DAILY PERIOD_CLOSE promotion that was live through the whole of yesterday,
 * so yesterday is a window it owes a settlement for until the hourly tick runs.
 */
function makePromotion(overrides: Record<string, unknown> = {}) {
    return prisma.cashbackPromotion.create({
        data: {
            name: `Closed window ${rnd()}`,
            lossThreshold: 50,
            refundType: 'FIXED',
            refundValue: 20,
            frequency: 'DAILY',
            payoutTiming: 'PERIOD_CLOSE',
            isActive: true,
            startsAt: new Date(Date.now() - 5 * DAY),
            endsAt: new Date(Date.now() + DAY),
            ...overrides,
        },
    })
}

/** A qualifying real-balance loss inside the window that has already closed. */
function loseYesterday(userId: string) {
    const previous = getPreviousPeriod(CashbackFrequency.DAILY)
    return prisma.transaction.create({
        data: {
            userId,
            type: 'GAME_ENTRY',
            amount: 100,
            status: 'APPROVED',
            createdAt: new Date(previous.periodStart.getTime() + HOUR),
        },
    })
}

describe('PATCH /admin/cashback/:id — a closed window may not be re-priced', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('refuses a payout-shaping edit while a closed window is unsettled', async () => {
        const admin = await mk('ADMIN')
        const promotion = await makePromotion()
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'PATCH',
            url: `/admin/cashback/${promotion.id}`,
            payload: { lossThreshold: 10 },
        })

        expect(res.statusCode).toBe(409)
        const previous = getPreviousPeriod(CashbackFrequency.DAILY)
        expect(res.json().error).toContain(previous.periodStart.toISOString())

        const unchanged = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: promotion.id } })
        expect(new Decimal(unchanged.lossThreshold).toNumber()).toBe(50)
    })

    it('still allows an edit that cannot change what the window pays', async () => {
        const admin = await mk('ADMIN')
        const promotion = await makePromotion()
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'PATCH',
            url: `/admin/cashback/${promotion.id}`,
            payload: { name: 'Renamed mid-window' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json().name).toBe('Renamed mid-window')
    })

    it('allows the payout-shaping edit once that window has settled', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER')
        const promotion = await makePromotion()
        await loseYesterday(player.id)

        // The hourly tick, which is what "settled" means here.
        const run = await CashbackService.runChecks()
        expect(run.totalDisbursed).toBe(1)

        const app = await buildApp(admin.id)
        const res = await app.inject({
            method: 'PATCH',
            url: `/admin/cashback/${promotion.id}`,
            payload: { refundValue: 30 },
        })

        expect(res.statusCode).toBe(200)
        const updated = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: promotion.id } })
        expect(new Decimal(updated.refundValue).toNumber()).toBe(30)
    })

    it('refuses an endsAt in the past, and refuses to revive a lapsed promotion', async () => {
        const admin = await mk('ADMIN')
        const live = await makePromotion()
        const lapsed = await makePromotion({ endsAt: new Date(Date.now() - HOUR) })
        const app = await buildApp(admin.id)

        const backwards = await app.inject({
            method: 'PATCH',
            url: `/admin/cashback/${live.id}`,
            payload: { endsAt: new Date(Date.now() - HOUR).toISOString() },
        })
        expect(backwards.statusCode).toBe(400)

        const revived = await app.inject({
            method: 'PATCH',
            url: `/admin/cashback/${lapsed.id}`,
            payload: { endsAt: new Date(Date.now() + DAY).toISOString() },
        })
        expect(revived.statusCode).toBe(409)

        const stillLapsed = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: lapsed.id } })
        expect(stillLapsed.endsAt.getTime()).toBeLessThan(Date.now())
    })
})

describe('POST /admin/cashback/:id/end', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('leaves the promotion drainable, so an earned closed window still pays', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER')
        const promotion = await makePromotion()
        await loseYesterday(player.id)
        const app = await buildApp(admin.id)

        const res = await app.inject({ method: 'POST', url: `/admin/cashback/${promotion.id}/end` })
        expect(res.statusCode).toBe(200)
        // isActive is what runChecks filters on and what checkAndDisburse bails
        // out over: clearing it here forfeits yesterday's payout.
        expect(res.json().isActive).toBe(true)
        expect(new Date(res.json().endsAt).getTime()).toBeLessThanOrEqual(Date.now())

        const run = await CashbackService.runChecks()
        expect(run.totalDisbursed).toBe(1)

        const previous = getPreviousPeriod(CashbackFrequency.DAILY)
        const disbursement = await prisma.cashbackDisbursement.findFirstOrThrow({ where: { promotionId: promotion.id } })
        expect(disbursement.periodStart.toISOString()).toBe(previous.periodStart.toISOString())

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(new Decimal(wallet.bonusBalance).toNumber()).toBe(20)
    })

    it('refuses a second end, which would move endsAt forward again', async () => {
        const admin = await mk('ADMIN')
        const promotion = await makePromotion()
        const app = await buildApp(admin.id)

        expect((await app.inject({ method: 'POST', url: `/admin/cashback/${promotion.id}/end` })).statusCode).toBe(200)
        const first = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: promotion.id } })

        const again = await app.inject({ method: 'POST', url: `/admin/cashback/${promotion.id}/end` })
        expect(again.statusCode).toBe(409)

        const second = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: promotion.id } })
        expect(second.endsAt.toISOString()).toBe(first.endsAt.toISOString())
    })
})

describe('GET /admin/promotions/summary', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('counts only promotion lots as outstanding liability', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER', 50)
        await prisma.bonusGrant.createMany({
            data: [
                { userId: player.id, amount: 30, remaining: 30, periodStart: new Date(), status: 'ACTIVE', source: 'ADMIN' },
                { userId: player.id, amount: 20, remaining: 20, periodStart: new Date(), status: 'ACTIVE', source: 'CASHBACK' },
            ],
        })
        const app = await buildApp(admin.id)

        const res = await app.inject({ method: 'GET', url: '/admin/promotions/summary' })
        expect(res.statusCode).toBe(200)
        // The manual 30 belongs to no promotion and has no payout tile beside it.
        expect(res.json().outstandingLiability).toBe(20)
    })
})

describe('POST /admin/players/:id/adjust-balance — grant validity', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('stores the expiry the admin asked for on the lot', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER')
        const app = await buildApp(admin.id)
        const expiresAt = new Date(Date.now() + 48 * HOUR).toISOString()

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'bonus', amount: 25, note: 'goodwill · valid 48h', expiresAt },
        })

        expect(res.statusCode).toBe(200)
        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(lot.expiresAt?.toISOString()).toBe(expiresAt)

        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { action: 'player.balance.adjust', target: `player:${player.id}` },
        })
        expect((audit.detail as any).expiresAt).toBe(expiresAt)
    })

    it('leaves the lot permanent when no expiry is sent', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: { type: 'bonus', amount: 25, note: 'goodwill · no expiry' },
        })

        expect(res.statusCode).toBe(200)
        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: player.id } })
        expect(lot.expiresAt).toBeNull()
    })

    it('refuses an expiry that has already passed', async () => {
        const admin = await mk('ADMIN')
        const player = await mk('PLAYER')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/adjust-balance`,
            payload: {
                type: 'bonus',
                amount: 25,
                note: 'goodwill',
                expiresAt: new Date(Date.now() - HOUR).toISOString(),
            },
        })

        expect(res.statusCode).toBe(400)
        expect(await prisma.bonusGrant.count({ where: { userId: player.id } })).toBe(0)
    })
})

describe('POST /admin/cashback — a promotion must be creatable complete', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('creates a paused, fully-priced promotion in one write', async () => {
        // Duplicating a live promotion used to be create-then-PATCH: the create
        // dropped the caps and the copy defaulted isActive true, then the PATCH
        // hit the closed-window guard and answered 409. The caller was told it
        // failed while a live, cap-less copy existed, ready to settle the same
        // window again under a second promotionId — which the
        // (promotionId, userId, periodStart) disbursement key does not stop.
        const admin = await mk('ADMIN')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/cashback',
            payload: {
                name: 'Copy of Weekend Cashback',
                lossThreshold: 500,
                refundType: 'PERCENTAGE',
                refundValue: 10,
                frequency: 'WEEKLY',
                startsAt: new Date(Date.now() - 30 * DAY).toISOString(),
                endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
                maxPayoutPerPlayer: 200,
                periodBudget: 5000,
                bonusValidityHours: 168,
                isActive: false,
            },
        })

        expect(res.statusCode).toBe(200)
        const created = await prisma.cashbackPromotion.findFirstOrThrow({
            where: { name: 'Copy of Weekend Cashback' },
        })
        expect(created.isActive).toBe(false)
        expect(new Decimal(created.maxPayoutPerPlayer!).toNumber()).toBe(200)
        expect(new Decimal(created.periodBudget!).toNumber()).toBe(5000)
        expect(created.bonusValidityHours).toBe(168)

        // Paused is what keeps it from paying: runChecks filters on isActive, so
        // a copy that inherited a past startsAt settles nothing until an admin
        // deliberately turns it on.
        const result = await CashbackService.runChecks()
        expect(result.settlements.some((x) => x.promotionId === created.id)).toBe(false)
    })

    it('still defaults to live and uncapped when those fields are omitted', async () => {
        // The normal create path must not start landing promotions paused just
        // because the duplicate path needs to.
        const admin = await mk('ADMIN')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: '/admin/cashback',
            payload: {
                name: 'Plain New Cashback',
                lossThreshold: 100,
                refundType: 'FIXED',
                refundValue: 25,
                frequency: 'DAILY',
                startsAt: new Date(Date.now() - HOUR).toISOString(),
                endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
            },
        })

        expect(res.statusCode).toBe(200)
        const created = await prisma.cashbackPromotion.findFirstOrThrow({ where: { name: 'Plain New Cashback' } })
        expect(created.isActive).toBe(true)
        expect(created.maxPayoutPerPlayer).toBeNull()
        expect(created.periodBudget).toBeNull()
    })
})

describe('/admin/players/:id/bonus-grants', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    async function playerWithLot(status: 'ACTIVE' | 'EXPIRED' = 'ACTIVE') {
        const active = status === 'ACTIVE'
        const player = await mk('PLAYER', active ? 50 : 0)
        const lot = await prisma.bonusGrant.create({
            data: {
                userId: player.id,
                amount: 50,
                remaining: active ? 50 : 0,
                periodStart: new Date(),
                expiresAt: new Date(Date.now() + HOUR),
                status,
                source: 'CASHBACK',
            },
        })
        return { player, lot }
    }

    it('reports each lot\'s source, so a cashback lot is not read as a manual credit', async () => {
        const admin = await mk('ADMIN')
        const { player } = await playerWithLot()
        const app = await buildApp(admin.id)

        const res = await app.inject({ method: 'GET', url: `/admin/players/${player.id}/bonus-grants` })
        expect(res.statusCode).toBe(200)
        expect(res.json().grants[0].source).toBe('CASHBACK')
    })

    it('reports nothing lost to expiry for a player who has lost nothing', async () => {
        // The companion to the cap suite's positive case: `expiredUnused` comes
        // from BONUS_EXPIRED rows, so a player with an active lot and no expiry
        // history must read 0 rather than inheriting some other player's total.
        const admin = await mk('ADMIN')
        const { player } = await playerWithLot()
        const app = await buildApp(admin.id)

        const res = await app.inject({ method: 'GET', url: `/admin/players/${player.id}/bonus-grants` })

        expect(res.statusCode).toBe(200)
        expect(res.json().expiredUnused).toBe(0)
    })

    it('extends an active lot and records who moved the deadline', async () => {
        const admin = await mk('ADMIN')
        const { player, lot } = await playerWithLot()
        const app = await buildApp(admin.id)
        const expiresAt = new Date(Date.now() + 72 * HOUR).toISOString()

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/bonus-grants/${lot.id}/extend`,
            payload: { expiresAt },
        })

        expect(res.statusCode).toBe(200)
        const after = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: lot.id } })
        expect(after.expiresAt?.toISOString()).toBe(expiresAt)
        expect(after.status).toBe('ACTIVE')
        // Untouched: an extension moves a deadline, never money.
        expect(new Decimal(after.remaining).toNumber()).toBe(50)

        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { action: 'player.bonus.extend', target: `player:${player.id}` },
        })
        expect(audit.actorId).toBe(admin.id)
        expect(audit.actorName).toBe(admin.username)
        expect((audit.detail as any).grantId).toBe(lot.id)
        expect((audit.detail as any).to).toBe(expiresAt)
    })

    it('makes a lot permanent when sent a null expiry', async () => {
        const admin = await mk('ADMIN')
        const { player, lot } = await playerWithLot()
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/bonus-grants/${lot.id}/extend`,
            payload: { expiresAt: null },
        })

        expect(res.statusCode).toBe(200)
        expect((await prisma.bonusGrant.findUniqueOrThrow({ where: { id: lot.id } })).expiresAt).toBeNull()
    })

    it('404s for a lot that belongs to a different player', async () => {
        const admin = await mk('ADMIN')
        const { lot } = await playerWithLot()
        const other = await mk('PLAYER')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${other.id}/bonus-grants/${lot.id}/extend`,
            payload: { expiresAt: new Date(Date.now() + DAY).toISOString() },
        })

        expect(res.statusCode).toBe(404)
        const untouched = await prisma.bonusGrant.findUniqueOrThrow({ where: { id: lot.id } })
        expect(untouched.expiresAt!.getTime()).toBeLessThan(Date.now() + 2 * HOUR)
    })

    it('404s for a lot that has already expired', async () => {
        const admin = await mk('ADMIN')
        const { player, lot } = await playerWithLot('EXPIRED')
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/bonus-grants/${lot.id}/extend`,
            payload: { expiresAt: new Date(Date.now() + DAY).toISOString() },
        })

        // Reviving it would need the wallet credited back too — that is a grant,
        // not an extension.
        expect(res.statusCode).toBe(404)
        expect((await prisma.bonusGrant.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe('EXPIRED')
    })

    it('400s on an expiry in the past', async () => {
        const admin = await mk('ADMIN')
        const { player, lot } = await playerWithLot()
        const app = await buildApp(admin.id)

        const res = await app.inject({
            method: 'POST',
            url: `/admin/players/${player.id}/bonus-grants/${lot.id}/extend`,
            payload: { expiresAt: new Date(Date.now() - DAY).toISOString() },
        })

        expect(res.statusCode).toBe(400)
    })
})
