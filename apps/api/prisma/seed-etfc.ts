import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const EVENT_NAME = 'ETFC Fight Night'

// 27 August 2026, 16:00 Africa/Addis_Ababa. Addis is a fixed UTC+3 with no DST,
// so the wall-clock card time is 13:00 UTC. Stored as an absolute instant.
const CLOSES_AT = new Date('2026-08-27T13:00:00.000Z')

type Bout = {
    /** Outcome sortOrder 0. */
    a: string
    /** Outcome sortOrder 1. */
    b: string
    discipline: 'MMA' | 'Boxing' | 'Muay Thai'
    weightClass: string
    rounds: number
    mainEvent?: boolean
}

/** The full ETFC Fight Night card, in running order. */
const CARD: Bout[] = [
    // MMA
    { a: 'Sedo "The Beast"', b: 'Johnny "Jiu-Jitsu"', discipline: 'MMA', weightClass: 'Heavyweight', rounds: 5, mainEvent: true },
    { a: 'Boyka', b: 'Endris', discipline: 'MMA', weightClass: 'Heavyweight', rounds: 3 },
    { a: 'Nikatehkina', b: 'Robel "Sky-Limit"', discipline: 'MMA', weightClass: '75 kg', rounds: 3 },
    { a: 'Titan', b: 'Coach Kal', discipline: 'MMA', weightClass: '75 kg', rounds: 3 },
    // Boxing
    { a: 'Abrhamalem', b: 'Tyson "Haymanot Desalegn"', discipline: 'Boxing', weightClass: '63.5 kg', rounds: 6 },
    { a: 'Surafel Cheri', b: 'Desalegn', discipline: 'Boxing', weightClass: '54 kg', rounds: 6 },
    { a: 'Esubalew', b: 'Biniyam', discipline: 'Boxing', weightClass: 'Lightweight', rounds: 6 },
    { a: 'Abenezer', b: 'Mesfin Biru', discipline: 'Boxing', weightClass: '71 kg', rounds: 6 },
    // Muay Thai
    { a: 'Rebik Sani', b: 'Sky Okony', discipline: 'Muay Thai', weightClass: '67 kg', rounds: 5 },
    { a: 'Frezer', b: 'Habtamu', discipline: 'Muay Thai', weightClass: '63 kg', rounds: 5 },
    { a: 'Zahara', b: 'Yabsira', discipline: 'Muay Thai', weightClass: '54 kg', rounds: 5 },
]

/**
 * The question doubles as the per-bout half of the idempotency key, so its shape
 * must stay stable — changing it re-seeds the card as eleven duplicates.
 */
function questionFor(bout: Bout): string {
    return `${bout.a} vs ${bout.b} — who wins?`
}

function descriptionFor(bout: Bout): string {
    const line = `${bout.discipline} — ${bout.weightClass}, ${bout.rounds} rounds`
    return bout.mainEvent ? `${line} — Main Event` : line
}

/**
 * Seeds the ETFC card. Exported so the main seed can call it directly rather
 * than shelling out to a second script — `RUN_SEED=true` then covers the fight
 * card too, on every environment, with no extra command to remember.
 *
 * Idempotent, and every market is left DRAFT: publishing is a deliberate admin
 * action, so running this on a live deployment adds nothing players can see.
 */
export async function seedEtfcCard() {
    console.log(`Seeding "${EVENT_NAME}" prediction markets...`)

    let created = 0
    let existingCount = 0

    for (const bout of CARD) {
        const question = questionFor(bout)

        // Idempotency key: (eventName, question). There is no unique constraint on
        // the pair — markets are admin-authored and free-form — so the lookup is
        // explicit. Re-running never duplicates a bout and never touches a market
        // that is already live.
        const existing = await prisma.predictionMarket.findFirst({
            where: { eventName: EVENT_NAME, question },
            select: { id: true, status: true },
        })

        let marketId: string
        if (existing) {
            marketId = existing.id
            existingCount += 1
            console.log(`  Already present (${existing.status}): ${question}`)
        } else {
            // shareValue and feePct are deliberately not set: they come from the
            // schema defaults so the denomination lives in exactly one place.
            // Left DRAFT — publishing is a deliberate admin action.
            const market = await prisma.predictionMarket.create({
                data: {
                    eventName: EVENT_NAME,
                    question,
                    description: descriptionFor(bout),
                    status: 'DRAFT',
                    closesAt: CLOSES_AT,
                },
                select: { id: true },
            })
            marketId = market.id
            created += 1
            console.log(`  Created DRAFT: ${question}`)
        }

        // Keyed on the (marketId, sortOrder) unique so a run that died halfway
        // through a market heals itself. Labels are never overwritten — money can
        // be escrowed against an outcome, and renaming one is indistinguishable
        // from rigging the market.
        const labels = [bout.a, bout.b]
        for (let sortOrder = 0; sortOrder < labels.length; sortOrder++) {
            await prisma.predictionOutcome.upsert({
                where: { marketId_sortOrder: { marketId, sortOrder } },
                update: {},
                create: { marketId, label: labels[sortOrder], sortOrder },
            })
        }
    }

    // Count only the bouts this script owns. Other markets legitimately share the
    // event name — the faceoff novelty markets do — so counting everything under
    // `eventName` would warn about markets that are supposed to be there.
    const bouts = await prisma.predictionMarket.count({
        where: { eventName: EVENT_NAME, question: { in: CARD.map(questionFor) } },
    })
    console.log(`Done — ${created} created, ${existingCount} already present, ${bouts}/${CARD.length} bouts on the card`)
    if (bouts !== CARD.length) {
        console.warn(`⚠  Expected ${CARD.length} bouts for "${EVENT_NAME}" but found ${bouts}`)
    }
}

// Standalone runner — only when invoked directly, so importing this module
// from seed.ts does not trigger a second run.
const invokedDirectly = process.argv[1]?.includes('seed-etfc')
if (invokedDirectly) {
    seedEtfcCard()
        .catch((e) => {
            console.error(e)
            process.exitCode = 1
        })
        .finally(() => prisma.$disconnect())
}
