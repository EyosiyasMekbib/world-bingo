import { describe, it, expect, afterEach } from 'vitest'
import { prisma, expectInvariantClean } from './setup'
import { BonusService } from '../services/bonus.service'
import { BonusReminderService } from '../services/bonus-reminder.service'

const HOUR_MS = 60 * 60 * 1000

async function makeUser(username: string, phone: string, overrides: Record<string, unknown> = {}) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 0, bonusBalance: 0 } },
            ...overrides,
        },
    })
}

async function grantExpiringIn(userId: string, amount: number, ms: number) {
    return prisma.$transaction((tx) =>
        BonusService.grant(tx, { userId, amount, source: 'ADMIN', expiresAt: new Date(Date.now() + ms) }),
    )
}

function warnings(userId: string) {
    return prisma.notification.findMany({ where: { userId, type: 'BONUS_EXPIRING' }, orderBy: { createdAt: 'asc' } })
}

// Tests BonusReminderService.sweepExpiring directly rather than the worker
// module — bonus-reminder.worker.ts is a thin BullMQ wrapper around this
// method, and importing it would fire its top-level Queue/Worker construction
// against live Redis with no teardown. Same reasoning as
// bonus-expiry.worker.test.ts.
describe('BonusReminderService.sweepExpiring', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('warns once for the 24h window and never again', async () => {
        const player = await makeUser('remind1', '+251900000041')
        const { grantId } = await grantExpiringIn(player.id, 50, 20 * HOUR_MS)

        const first = await BonusReminderService.sweepExpiring()
        expect(first.notificationsSent).toBe(1)
        expect(first.usersNotified).toBe(1)
        expect(first.byWindow['24h']).toBe(1)
        expect(first.byWindow['2h']).toBe(0)

        const sent = await warnings(player.id)
        expect(sent).toHaveLength(1)
        const metadata = sent[0].metadata as Record<string, unknown>
        expect(metadata.grantId).toBe(grantId)
        expect(metadata.window).toBe('24h')
        expect(sent[0].body).toContain('50.00 ETB')
        // Default spendAccount is REAL, so the bonus is unspendable as configured
        // — the nudge is the reason the notification exists at all.
        expect(sent[0].body).toContain('Switch to Spend Bonus')

        const second = await BonusReminderService.sweepExpiring()
        expect(second.notificationsSent).toBe(0)
        expect(await warnings(player.id)).toHaveLength(1)
    })

    it('says nothing about a lot expiring beyond the outer window', async () => {
        const player = await makeUser('remind2', '+251900000042')
        await grantExpiringIn(player.id, 50, 40 * HOUR_MS)

        const result = await BonusReminderService.sweepExpiring()

        expect(result.notificationsSent).toBe(0)
        expect(await warnings(player.id)).toHaveLength(0)
    })

    it('uses the 2h window only, for a lot already inside it', async () => {
        const player = await makeUser('remind3', '+251900000043')
        await grantExpiringIn(player.id, 30, 75 * 60 * 1000)

        const result = await BonusReminderService.sweepExpiring()

        expect(result.byWindow['2h']).toBe(1)
        expect(result.byWindow['24h']).toBe(0)
        const sent = await warnings(player.id)
        expect(sent).toHaveLength(1)
        expect((sent[0].metadata as Record<string, unknown>).window).toBe('2h')
        expect(sent[0].body).toMatch(/7[0-9] minutes/)
    })

    it('warns a second time once the same lot crosses into the 2h window', async () => {
        const player = await makeUser('remind4', '+251900000044')
        await grantExpiringIn(player.id, 40, 20 * HOUR_MS)

        await BonusReminderService.sweepExpiring()
        // Nineteen hours later the lot is one hour from death; the 24h receipt
        // must not silence the urgent warning.
        const later = new Date(Date.now() + 19 * HOUR_MS)
        const result = await BonusReminderService.sweepExpiring(later)

        expect(result.byWindow['2h']).toBe(1)
        const windows = (await warnings(player.id)).map((n) => (n.metadata as Record<string, unknown>).window)
        expect(windows).toEqual(['24h', '2h'])
    })

    it('skips bots, suspended accounts and fully consumed lots', async () => {
        const bot = await makeUser('bot_t7', '+251900000045')
        const suspended = await makeUser('remind5', '+251900000046', { accountStatus: 'SUSPENDED' })
        const spender = await makeUser('remind6', '+251900000047')

        await grantExpiringIn(bot.id, 10, 20 * HOUR_MS)
        await grantExpiringIn(suspended.id, 10, 20 * HOUR_MS)
        await grantExpiringIn(spender.id, 10, 20 * HOUR_MS)
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${spender.id} FOR UPDATE`
            await BonusService.spend(tx, spender.id, 10)
        })

        const result = await BonusReminderService.sweepExpiring()

        expect(result.notificationsSent).toBe(0)
        expect(await warnings(bot.id)).toHaveLength(0)
        expect(await warnings(suspended.id)).toHaveLength(0)
        expect(await warnings(spender.id)).toHaveLength(0)
    })
})
