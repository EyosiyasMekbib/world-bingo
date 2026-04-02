import { beforeAll, afterAll, afterEach, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'

// Global test setup
export const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/world_bingo_test',
        },
    },
})

beforeAll(async () => {
    // Connect to test database
    await prisma.$connect()
    await cleanDb()
})

afterEach(async () => {
    await cleanDb()
})

afterAll(async () => {
    await prisma.$disconnect()
})

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

// Mock external dependencies
// hash always returns 'hashed_password'; compare returns true only when
// the plain-text value matches what was "hashed" (i.e. 'hashed_password' itself
// is never a real input — we simulate correctness by checking the stored hash).
vi.mock('bcryptjs', () => ({
    default: {
        hash: vi.fn().mockImplementation((password: string) =>
            Promise.resolve(`hashed:${password}`),
        ),
        compare: vi.fn().mockImplementation((password: string, hash: string) =>
            Promise.resolve(hash === `hashed:${password}`),
        ),
    },
}))

