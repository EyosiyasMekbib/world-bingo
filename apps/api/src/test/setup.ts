import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'

// Global test setup
export const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
})

/**
 * Asserts the system-level bonus invariant holds for every wallet in the DB:
 * wallet.bonusBalance == SUM(bonus_grants.remaining WHERE status = 'ACTIVE').
 *
 * Every real-DB suite that exercises a BonusService-touching code path
 * (join/leave a game, cancel a prediction order, disburse cashback, admin
 * balance adjustments, bonus expiry, etc.) should call this from its own
 * `afterEach`, AFTER the test's own assertions but BEFORE the `cleanDb()`
 * hook below runs — so it checks the state the test actually left behind,
 * not a freshly-wiped DB. This closes the blind spot where BonusService's
 * own unit tests only prove it is internally self-consistent, never that a
 * real end-to-end flow leaves the wallet/lot invariant intact.
 *
 * Deliberately reimplements `BonusService.reconcile()`'s query here rather
 * than calling it, for two reasons that both caused real breakage when this
 * helper first delegated to the service:
 *
 *  1. Importing `BonusService` into this setup file pulls its whole module
 *     graph (its own module-level `PrismaClient` from `lib/prisma`, plus
 *     `NotificationService` → `lib/socket`) into EVERY test file, ahead of
 *     each file's own `vi.mock` wiring — a second connection pool and a
 *     socket dependency loaded into suites that never asked for either.
 *  2. `reconcile()` is written for the admin dashboard: an unbounded
 *     full-table scan. Running that after every single test is the wrong
 *     shape for a per-test assertion.
 *
 * The SQL below is the same comparison, run on the test's own client. It is
 * intentionally a duplicate of a one-line aggregate, not shared logic — if
 * `reconcile()`'s definition of the invariant ever changes, this should be
 * updated to match, and the mismatch itself would be worth noticing.
 */
export async function expectInvariantClean() {
    const mismatches = await prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT w."userId"
        FROM wallets w
        LEFT JOIN bonus_grants g
          ON g."userId" = w."userId" AND g.status = 'ACTIVE'
        GROUP BY w."userId", w."bonusBalance"
        HAVING w."bonusBalance" <> COALESCE(SUM(g.remaining), 0)
    `
    expect(mismatches).toEqual([])
}

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
    // CRM tables first. campaign_deliveries holds an onDelete: Restrict FK to
    // users, so leaving a row here would make the users.deleteMany() below fail
    // and cascade confusing failures through every later suite.
    await prisma.campaignDelivery.deleteMany()
    await prisma.campaign.deleteMany()
    await prisma.bonusGrant.deleteMany()
    await prisma.bonusRule.deleteMany()
    await prisma.segment.deleteMany()
    await prisma.playerMetrics.deleteMany()
    await prisma.cashbackDisbursement.deleteMany()
    await prisma.cashbackPromotion.deleteMany()
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
    await prisma.thirdPartyTransaction.deleteMany()
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

