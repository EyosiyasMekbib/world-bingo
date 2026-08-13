import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PlayerMetricsService } from '../services/player-crm/player-metrics.service'
import { prisma } from './setup'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'

vi.mock('../lib/socket', () => ({
    getIo: () => ({ to: () => ({ emit: vi.fn() }), emit: vi.fn() }),
}))

/**
 * The rollup is one large hand-written SQL statement. These tests exist to prove
 * it agrees with the obvious per-user computation, because a silent aggregation
 * bug here doesn't crash anything — it just quietly targets the wrong players.
 */

async function makePlayer(opts: {
    username: string
    phone: string
    real?: number
    bonus?: number
    role?: string
    passwordHash?: string
}) {
    return prisma.user.create({
        data: {
            username: opts.username,
            phone: opts.phone,
            passwordHash: opts.passwordHash ?? 'hashed:pass',
            role: (opts.role ?? 'PLAYER') as never,
            wallet: { create: { realBalance: opts.real ?? 0, bonusBalance: opts.bonus ?? 0 } },
        },
    })
}

async function tx(userId: string, type: string, amount: number, status = 'APPROVED') {
    return prisma.transaction.create({
        data: {
            userId,
            type: type as never,
            status: status as never,
            amount,
            balanceBefore: 0,
            balanceAfter: 0,
            bonusBalanceBefore: 0,
            bonusBalanceAfter: 0,
        },
    })
}

async function makeGameWithEntries(userId: string, cartelaCount: number, suffix: string) {
    const game = await prisma.game.create({
        data: {
            title: `Metrics Game ${suffix}`,
            ticketPrice: 10,
            maxPlayers: 70,
            minPlayers: 2,
            houseEdgePct: 10,
            pattern: 'ANY_LINE',
            status: 'COMPLETED',
            calledBalls: [],
        },
    })
    for (let i = 0; i < cartelaCount; i++) {
        const grid = generateCartela()
        const cartela = await prisma.cartela.create({
            data: { serial: `MET-${suffix}-${generateSerial(grid)}-${i}`, grid: grid as never },
        })
        await prisma.gameEntry.create({
            data: { gameId: game.id, userId, cartelaId: cartela.id },
        })
    }
    return game
}

describe('PlayerMetricsService.refreshAll — aggregate correctness', () => {
    let userId: string

    beforeEach(async () => {
        const user = await makePlayer({
            username: 'metrics_player',
            phone: '+251900600001',
            real: 250,
            bonus: 40,
        })
        userId = user.id

        // Deposits: two approved (500 + 300), one pending that must NOT count.
        await tx(userId, 'DEPOSIT', 500)
        await tx(userId, 'DEPOSIT', 300)
        await tx(userId, 'DEPOSIT', 9999, 'PENDING_REVIEW')

        // Withdrawal, stake, win, bonus.
        await tx(userId, 'WITHDRAWAL', 100)
        await tx(userId, 'GAME_ENTRY', 60)
        await tx(userId, 'PRIZE_WIN', 25)
        await tx(userId, 'CASHBACK_BONUS', 15)

        // One game, three cartelas → gamesPlayed 1, cartelasBought 3.
        await makeGameWithEntries(userId, 3, 'a')
    })

    it('counts only APPROVED deposits', async () => {
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(Number(m!.lifetimeDeposits)).toBe(800)
        expect(m!.depositCount).toBe(2)
    })

    it('records withdrawals, stakes, wins and bonuses', async () => {
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(Number(m!.lifetimeWithdrawals)).toBe(100)
        expect(m!.withdrawalCount).toBe(1)
        expect(Number(m!.totalStaked)).toBe(60)
        expect(Number(m!.totalWon)).toBe(25)
        expect(Number(m!.bonusReceived)).toBe(15)
    })

    it('counts distinct games but every cartela', async () => {
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(m!.gamesPlayed).toBe(1)
        expect(m!.cartelasBought).toBe(3)
    })

    it('computes netLoss across bingo and casino together', async () => {
        // Casino: staked 200, won 50. Bingo: staked 60, won 25.
        // net = (60 + 200) - (25 + 50) = 185
        const provider = await prisma.gameProvider.create({
            data: { code: `prov-${Date.now()}`, name: 'Test', status: 'ACTIVE', apiBaseUrl: '', currency: 'ETB', config: {} },
        })
        await prisma.thirdPartyTransaction.createMany({
            data: [
                {
                    userId,
                    providerId: provider.id,
                    transactionId: `bet-${Date.now()}`,
                    type: 'BET',
                    status: 'COMPLETED',
                    amount: -200,
                    balanceBefore: 0,
                    balanceAfter: 0,
                },
                {
                    userId,
                    providerId: provider.id,
                    transactionId: `win-${Date.now()}`,
                    type: 'BET_RESULT',
                    status: 'COMPLETED',
                    amount: 50,
                    balanceBefore: 0,
                    balanceAfter: 0,
                },
            ],
        })

        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(Number(m!.tpStaked)).toBe(200)
        expect(Number(m!.tpWon)).toBe(50)
        expect(Number(m!.netLoss)).toBe(185)
    })

    it('denormalizes wallet balances and identity so segment queries need no joins', async () => {
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(Number(m!.realBalance)).toBe(250)
        expect(Number(m!.bonusBalance)).toBe(40)
        expect(m!.phone).toBe('+251900600001')
        expect(m!.isActive).toBe(true)
    })

    it('sets recency to 0 for activity that happened today', async () => {
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId } })

        expect(m!.daysSinceLastDeposit).toBe(0)
        expect(m!.daysSinceLastPlay).toBe(0)
        expect(m!.tenureDays).toBe(0)
    })

    it('leaves recency null for a player who never deposited or played', async () => {
        const quiet = await makePlayer({ username: 'never_active', phone: '+251900600002' })
        await PlayerMetricsService.refreshAll()
        const m = await prisma.playerMetrics.findUnique({ where: { userId: quiet.id } })

        // NULL, not 0 — "never deposited" and "deposited today" must not collide.
        expect(m!.daysSinceLastDeposit).toBeNull()
        expect(m!.daysSinceLastPlay).toBeNull()
        expect(m!.depositCount).toBe(0)
    })
})

describe('PlayerMetricsService.refreshAll — exclusions', () => {
    it('excludes bot accounts, whose house-funded play would skew every aggregate', async () => {
        const bot = await makePlayer({
            username: 'bot_player',
            phone: '+251900600003',
            passwordHash: 'BOT_ACCOUNT',
        })
        await tx(bot.id, 'DEPOSIT', 5000)

        await PlayerMetricsService.refreshAll()

        expect(await prisma.playerMetrics.findUnique({ where: { userId: bot.id } })).toBeNull()
    })

    it('excludes staff accounts', async () => {
        const admin = await makePlayer({
            username: 'staff_member',
            phone: '+251900600004',
            role: 'ADMIN',
        })

        await PlayerMetricsService.refreshAll()

        expect(await prisma.playerMetrics.findUnique({ where: { userId: admin.id } })).toBeNull()
    })
})

describe('PlayerMetricsService — idempotency and incremental refresh', () => {
    it('produces identical values when run twice (absolute recompute, not increment)', async () => {
        const user = await makePlayer({ username: 'twice_player', phone: '+251900600005' })
        await tx(user.id, 'DEPOSIT', 400)

        await PlayerMetricsService.refreshAll()
        const first = await prisma.playerMetrics.findUnique({ where: { userId: user.id } })

        await PlayerMetricsService.refreshAll()
        const second = await prisma.playerMetrics.findUnique({ where: { userId: user.id } })

        // The whole safety argument for retries rests on this.
        expect(Number(second!.lifetimeDeposits)).toBe(Number(first!.lifetimeDeposits))
        expect(Number(second!.lifetimeDeposits)).toBe(400)
        expect(second!.depositCount).toBe(1)
    })

    it('refreshUsers updates only the named player', async () => {
        const a = await makePlayer({ username: 'target_a', phone: '+251900600006' })
        const b = await makePlayer({ username: 'other_b', phone: '+251900600007' })
        await tx(a.id, 'DEPOSIT', 100)
        await tx(b.id, 'DEPOSIT', 200)

        await PlayerMetricsService.refreshUsers([a.id])

        expect(await prisma.playerMetrics.findUnique({ where: { userId: a.id } })).not.toBeNull()
        expect(await prisma.playerMetrics.findUnique({ where: { userId: b.id } })).toBeNull()
    })

    it('picks up a raw-SQL freeze that bumps no timestamp', async () => {
        // freeze_flagged.sql freezes fraud accounts with a raw UPDATE. Prisma's
        // @updatedAt does not fire, so the watermark cannot see it — if liveness
        // were only refreshed for "touched" users, a frozen account would stay
        // targetable by campaigns until the nightly rebuild.
        const user = await makePlayer({ username: 'to_freeze', phone: '+251900600009' })
        await PlayerMetricsService.refreshAll()
        expect((await prisma.playerMetrics.findUnique({ where: { userId: user.id } }))!.isActive).toBe(true)

        await prisma.$executeRaw`UPDATE users SET "isActive" = false WHERE id = ${user.id}`

        await PlayerMetricsService.refreshIncremental()

        const after = await prisma.playerMetrics.findUnique({ where: { userId: user.id } })
        expect(after!.isActive).toBe(false)
    })

    it('finds players touched since the watermark', async () => {
        const user = await makePlayer({ username: 'stale_player', phone: '+251900600008' })
        const before = new Date(Date.now() - 60_000)
        await tx(user.id, 'DEPOSIT', 50)

        const ids = await PlayerMetricsService.findStaleUserIds(before)

        expect(ids).toContain(user.id)
    })
})
