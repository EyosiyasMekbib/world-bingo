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
    
    // Clean database before tests
    await prisma.transaction.deleteMany()
    await prisma.gameEntry.deleteMany()
    await prisma.cartela.deleteMany()
    await prisma.game.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.user.deleteMany()
})

afterEach(async () => {
    // Clean database after each test
    await prisma.transaction.deleteMany()
    await prisma.gameEntry.deleteMany()
    await prisma.cartela.deleteMany()
    await prisma.game.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.user.deleteMany()
})

afterAll(async () => {
    await prisma.$disconnect()
})

// Mock external dependencies
vi.mock('bcryptjs', () => ({
    default: {
        hash: vi.fn().mockResolvedValue('hashed_password'),
        compare: vi.fn().mockResolvedValue(true),
    },
}))
