import { describe, it, expect, afterEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma, expectInvariantClean } from './setup'
import { BonusService } from '../services/bonus.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

// Tests BonusService.sweepExpired directly rather than the worker module —
// bonus-expiry.worker.ts is a thin BullMQ wrapper around this method
// (matching how every other worker in this codebase wraps a testable
// service; no other worker file is imported by tests). Importing the worker
// module instead would fire its real top-level Queue/Worker construction
// against live Redis with no teardown.
describe('BonusService.sweepExpired', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('expires due lots across multiple users and writes one BONUS_EXPIRED transaction each', async () => {
        const userA = await makeUser('sweep1', '+251900000031')
        const userB = await makeUser('sweep2', '+251900000032')
        const past = new Date(Date.now() - 1000)

        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: userA.id, amount: 25, source: 'ADMIN', expiresAt: past }))
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: userB.id, amount: 15, source: 'ADMIN', expiresAt: past }))

        const result = await BonusService.sweepExpired()

        expect(result.usersProcessed).toBe(2)
        expect(result.totalExpired).toBe('40.00')

        const txnA = await prisma.transaction.findFirstOrThrow({ where: { userId: userA.id, type: 'BONUS_EXPIRED' } })
        expect(new Decimal(txnA.amount).toNumber()).toBe(25)

        const walletA = await prisma.wallet.findUniqueOrThrow({ where: { userId: userA.id } })
        expect(new Decimal(walletA.bonusBalance).toNumber()).toBe(0)
    })

    it('is a no-op when nothing is due', async () => {
        const result = await BonusService.sweepExpired()
        expect(result.usersProcessed).toBe(0)
    })
})
