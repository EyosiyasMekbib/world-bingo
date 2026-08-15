/**
 * LOCAL DEMO DATA — a populated prediction market to look at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT PRODUCTION DATA AND MUST NEVER REACH A REAL DEPLOYMENT.
 *
 * It invents users and their trading. On a live book that would be fabricated
 * activity shown to real bettors, so the script refuses to run anywhere that
 * looks non-local (see `assertLocalOnly`) rather than relying on anyone
 * remembering not to run it. Everything it writes is prefixed/tagged so
 * `--purge` can remove all of it again.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY IT TRADES INSTEAD OF INSERTING ROWS. The obvious way to fake a busy book
 * is to write `prediction_fills` and a big `totalVolume` directly. That produces
 * data the app cannot actually have produced: positions that do not sum to the
 * escrow, payouts that do not reconcile, a chart drawn from prices no order ever
 * paid. Instead this drives real orders through `PredictionOrderService`, so the
 * matching engine produces every fill, and settles through
 * `PredictionSettlementService`, so every payout is the real calculation.
 *
 * The result is demo data that is internally consistent by construction — and a
 * genuine load test of the engine, since it puts thousands of shares through the
 * same code path a real fight night would.
 *
 * Usage (from apps/api):
 *   pnpm db:seed:demo            seed
 *   pnpm db:seed:demo -- --purge remove everything it created
 */

import { PrismaClient, Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { PredictionMarketService } from '../src/services/prediction/market.service.js'
import { PredictionOrderService } from '../src/services/prediction/order.service.js'
import { PredictionSettlementService } from '../src/services/prediction/settlement.service.js'

const prisma = new PrismaClient()

/** Everything this script creates carries one of these markers. */
const DEMO_USER_PREFIX = 'demo_'
const DEMO_EVENT_TAG = '[DEMO]'

// ─── Guard ───────────────────────────────────────────────────────────────────

/**
 * Refuse to run anywhere that is not obviously a local development database.
 *
 * Three independent conditions, all required. A single env var would be one
 * typo away from seeding invented traders into a real book.
 */
function assertLocalOnly(): void {
    const env = process.env.NODE_ENV ?? 'development'
    const url = process.env.DATABASE_URL ?? ''

    const problems: string[] = []

    if (env === 'production') {
        problems.push(`NODE_ENV is "${env}"`)
    }

    let host = ''
    try {
        host = new URL(url).hostname
    } catch {
        problems.push('DATABASE_URL is unparseable')
    }
    if (host && !['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host)) {
        problems.push(`DATABASE_URL points at "${host}", which is not local`)
    }

    // A local database can still be the wrong one. Require the name to look like
    // a dev database rather than, say, a production dump restored for debugging.
    const dbName = url.split('/').pop()?.split('?')[0] ?? ''
    if (dbName && !/dev|test|local|demo/i.test(dbName)) {
        problems.push(`database "${dbName}" is not named like a dev database`)
    }

    if (problems.length > 0) {
        console.error('\n  REFUSING TO RUN — this script invents users and trades.\n')
        for (const p of problems) console.error(`    · ${p}`)
        console.error('\n  It is for a local development database only.\n')
        process.exit(1)
    }
}

// ─── Cast ────────────────────────────────────────────────────────────────────

/** Demo traders. Ordinary Ethiopian names so the tape reads plausibly. */
const TRADERS = [
    'abel', 'bereket', 'chaltu', 'dawit', 'eyob', 'fikir', 'genet', 'hanna',
    'kalkidan', 'lensa', 'meron', 'nahom', 'rahel', 'samuel', 'tigist',
    'yonas', 'zerihun', 'selam', 'biruk', 'mahlet',
]

interface DemoMarket {
    question: string
    description: string
    /** Days before now that the market closed. */
    closedDaysAgo: number
    /** Index of the outcome that won, 0 or 1. */
    winner: 0 | 1
    outcomes: [string, string]
    /**
     * Price path the book trades through, as outcome-0 prices in whole birr.
     * The last value ends up near the truth, the way a real book converges.
     */
    path: number[]
    /** Shares per fill. Bigger on the headline markets. */
    size: number
}

/**
 * Past events, already decided. Prices drift toward the outcome that won, which
 * is what a real book does as information arrives.
 */
const MARKETS: DemoMarket[] = [
    {
        question: 'Sofiya "The Hammer" vs Dani "Cobra" — who wins?',
        description: 'ETFC 1.0 · MMA — Welterweight, 3 rounds — Main Event',
        closedDaysAgo: 96,
        winner: 0,
        outcomes: ['Sofiya "The Hammer"', 'Dani "Cobra"'],
        path: [44, 48, 46, 53, 57, 55, 62, 66, 64, 71, 75, 78, 82, 79, 85],
        size: 180,
    },
    {
        question: 'Mikiyas vs Tewodros — who wins?',
        description: 'ETFC 1.0 · Boxing — 67 kg, 6 rounds',
        closedDaysAgo: 96,
        winner: 1,
        outcomes: ['Mikiyas', 'Tewodros'],
        path: [58, 55, 60, 52, 47, 49, 42, 38, 40, 33, 29, 25, 21, 18],
        size: 120,
    },
    {
        question: 'Hayat vs Ruth — who wins?',
        description: 'ETFC 1.0 · Muay Thai — 54 kg, 5 rounds',
        closedDaysAgo: 96,
        winner: 0,
        outcomes: ['Hayat', 'Ruth'],
        path: [50, 54, 51, 58, 61, 59, 65, 68, 72, 70, 76, 81],
        size: 95,
    },
    {
        question: 'Does an Ethiopian win the Great Ethiopian Run 10K?',
        description: 'Athletics · Addis Ababa — resolved from the official result',
        closedDaysAgo: 61,
        winner: 0,
        outcomes: ['Yes', 'No'],
        path: [72, 75, 74, 79, 82, 80, 85, 88, 91, 89, 93],
        size: 240,
    },
    {
        question: 'Do the Walia Ibex keep a clean sheet at home?',
        description: 'Football · Ethiopia national team — resolved from the official result',
        closedDaysAgo: 44,
        winner: 1,
        outcomes: ['Yes', 'No'],
        path: [46, 43, 47, 40, 36, 39, 33, 29, 31, 24, 20],
        size: 160,
    },
    {
        question: 'Does it rain in Addis Ababa on the day of the final?',
        description: 'Weather · Addis Ababa — resolved from the Ethiopian Meteorology Institute',
        closedDaysAgo: 30,
        winner: 0,
        outcomes: ['Yes', 'No'],
        path: [61, 64, 62, 68, 71, 69, 74, 77, 80, 84],
        size: 130,
    },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHARE_VALUE = 100
/** Enough that a trader can never be the reason a fill fails to place. */
const TRADER_FLOAT = new Prisma.Decimal(5_000_000)

async function ensureTraders(): Promise<string[]> {
    const passwordHash = await bcrypt.hash('demo-only-not-a-real-account', 10)
    const ids: string[] = []

    for (let i = 0; i < TRADERS.length; i++) {
        const username = `${DEMO_USER_PREFIX}${TRADERS[i]}`
        const phone = `+2519${String(70_000_000 + i).slice(0, 8)}`

        const existing = await prisma.user.findUnique({ where: { username } })
        const user = existing
            ? existing
            : await prisma.user.create({
                data: {
                    username,
                    phone,
                    passwordHash,
                    role: 'PLAYER',
                    wallet: { create: { realBalance: TRADER_FLOAT } },
                },
            })

        // Top the float back up so a re-run is not starved by the last one.
        await prisma.wallet.updateMany({
            where: { userId: user.id },
            data: { realBalance: TRADER_FLOAT, bonusBalance: 0 },
        })
        ids.push(user.id)
    }

    console.log(`  traders: ${ids.length} ready`)
    return ids
}

/**
 * Trade one market to its close and settle it.
 *
 * Each step is a matched pair: one trader takes outcome 0 at `p`, another takes
 * outcome 1 at `shareValue - p`, so every fill escrows exactly one share value.
 * Buyers rotate through the cast so positions spread across many names rather
 * than two.
 */
async function runMarket(spec: DemoMarket, traders: string[], startIndex: number): Promise<{ shares: number; volume: number }> {
    const closesAt = new Date(Date.now() - spec.closedDaysAgo * 86_400_000)
    // Created before it closed, the way a real market exists first.
    const market = await PredictionMarketService.createMarket({
        eventName: `${DEMO_EVENT_TAG} ${spec.description.split('·')[0]?.trim() || 'Demo'}`,
        question: spec.question,
        description: spec.description,
        // Far enough ahead that publish/validation accepts it; corrected below.
        closesAt: new Date(Date.now() + 86_400_000),
        shareValue: SHARE_VALUE,
        minOrderShares: 1,
        maxOrderShares: 100_000,
        outcomes: [
            { label: spec.outcomes[0], sortOrder: 0 },
            { label: spec.outcomes[1], sortOrder: 1 },
        ],
    })

    await PredictionMarketService.publishMarket(market.id)

    const [outA, outB] = [...market.outcomes].sort((x, y) => x.sortOrder - y.sortOrder)
    let shares = 0
    let cursor = startIndex

    for (const price of spec.path) {
        const buyerA = traders[cursor % traders.length]!
        const buyerB = traders[(cursor + 7) % traders.length]! // +7 so A and B are never the same trader
        cursor += 1

        // Resting side first, then the taker that completes the share.
        await PredictionOrderService.placeOrder(buyerA, {
            marketId: market.id,
            outcomeId: outA!.id,
            limitPrice: price,
            quantity: spec.size,
        })
        await PredictionOrderService.placeOrder(buyerB, {
            marketId: market.id,
            outcomeId: outB!.id,
            limitPrice: SHARE_VALUE - price,
            quantity: spec.size,
        })
        shares += spec.size
    }

    // Backdate the market into the past, then close → resolve → settle.
    await prisma.predictionMarket.update({
        where: { id: market.id },
        data: { closesAt, createdAt: new Date(closesAt.getTime() - 5 * 86_400_000) },
    })
    await PredictionMarketService.closeMarket(market.id)

    const winnerId = spec.winner === 0 ? outA!.id : outB!.id
    await PredictionMarketService.resolveMarket(market.id, winnerId)

    // Settlement refuses to run before the dispute window expires — push it into
    // the past rather than waiting 30 real minutes.
    await prisma.predictionMarket.update({
        where: { id: market.id },
        data: { disputeUntil: new Date(Date.now() - 60_000) },
    })
    const result = await PredictionSettlementService.settleMarket(market.id)

    const volume = shares * SHARE_VALUE
    console.log(
        `  ✓ ${spec.question.slice(0, 46).padEnd(48)} ${String(shares).padStart(6)} shares  ${volume.toLocaleString().padStart(11)} ETB  → ${spec.outcomes[spec.winner]}`,
    )
    void result
    return { shares, volume }
}

// ─── Purge ───────────────────────────────────────────────────────────────────

async function purge(): Promise<void> {
    const markets = await prisma.predictionMarket.findMany({
        where: { eventName: { startsWith: DEMO_EVENT_TAG } },
        select: { id: true },
    })
    const ids = markets.map((m) => m.id)

    if (ids.length > 0) {
        await prisma.predictionFill.deleteMany({ where: { marketId: { in: ids } } })
        await prisma.predictionOrder.deleteMany({ where: { marketId: { in: ids } } })
        await prisma.predictionPosition.deleteMany({ where: { marketId: { in: ids } } })
        await prisma.predictionOutcome.deleteMany({ where: { marketId: { in: ids } } })
        await prisma.predictionMarket.deleteMany({ where: { id: { in: ids } } })
    }

    const users = await prisma.user.findMany({
        where: { username: { startsWith: DEMO_USER_PREFIX } },
        select: { id: true },
    })
    const userIds = users.map((u) => u.id)
    if (userIds.length > 0) {
        await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
        await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }

    console.log(`Purged ${ids.length} demo markets and ${userIds.length} demo users.`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    assertLocalOnly()

    if (process.argv.includes('--purge')) {
        await purge()
        return
    }

    console.log('\nSeeding demo prediction history (local only)\n')

    // Re-running should replace, not stack.
    await purge()

    const traders = await ensureTraders()

    let totalShares = 0
    let totalVolume = 0
    for (let i = 0; i < MARKETS.length; i++) {
        const { shares, volume } = await runMarket(MARKETS[i]!, traders, i * 3)
        totalShares += shares
        totalVolume += volume
    }

    console.log(
        `\n  ${MARKETS.length} settled markets · ${totalShares.toLocaleString()} shares · ${totalVolume.toLocaleString()} ETB traded\n`,
    )
    console.log(`  Remove it all again with:  pnpm db:seed:demo -- --purge\n`)
}

main()
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
