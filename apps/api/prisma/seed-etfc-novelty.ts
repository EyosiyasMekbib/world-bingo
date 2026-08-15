/**
 * ETFC 2.0 novelty markets — the faceoff sideshow.
 *
 * These are real markets on a real upcoming event, seeded as DRAFT so nothing
 * is public until an admin publishes it.
 *
 * WHY THE RESOLUTION RULE IS THE MOST IMPORTANT FIELD HERE. A "who wins" market
 * settles itself: the fight has an official result and nobody argues. A novelty
 * market does not — it settles on somebody's reading of a video, so the rule has
 * to be written down BEFORE money goes in, precise enough that two people
 * watching the same footage reach the same answer. Every description below
 * therefore states the source, what counts, what does not, and what happens when
 * the footage does not exist. Vague novelty markets are how a book ends up
 * arguing with its own players.
 *
 * Usage (from apps/api):
 *   pnpm db:seed:etfc:novelty
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const EVENT_NAME = 'ETFC Fight Night'

/**
 * The faceoff, not the card. Staredowns happen at the weigh-in the day before,
 * so these close earlier than the bout markets — a market must close before the
 * thing it predicts can be observed, or someone bets on a known outcome.
 *
 * 26 August 2026, 17:00 Africa/Addis_Ababa (UTC+3, no DST) = 14:00 UTC.
 * VERIFY THIS AGAINST THE OFFICIAL SCHEDULE before publishing.
 */
const FACEOFF_CLOSES_AT = new Date('2026-08-26T14:00:00.000Z')

interface NoveltyMarket {
    question: string
    description: string
    /** Yes first (sortOrder 0), No second — so the chart line tracks "Yes". */
    outcomes: [string, string]
}

const MARKETS: NoveltyMarket[] = [
    {
        question: 'Will Johnny "Jiu-Jitsu" throw an egg at the ETFC 2.0 faceoff?',
        description:
            'Novelty — Faceoff. ' +
            'Resolves YES if, on the official ETFC broadcast or ETFC-published footage of the ETFC 2.0 faceoff, ' +
            'Johnny "Jiu-Jitsu" throws an egg at his opponent. ' +
            'Any other thrown object does not count, and neither does a shove, slap, or contact with nothing thrown. ' +
            'The egg does not need to hit or break. ' +
            'Resolves NO if the faceoff takes place and no egg is thrown by Johnny. ' +
            'VOIDS and refunds in full if no official footage of the faceoff is published, or if the faceoff does not take place.',
        outcomes: ['Yes', 'No'],
    },
    {
        question: 'Will Nikate Helina say "ene kemetate befit" at the ETFC 2.0 faceoff?',
        description:
            'Novelty — Faceoff. ' +
            'Resolves YES if, on the official ETFC broadcast or ETFC-published footage of the ETFC 2.0 faceoff, ' +
            'Nikate Helina says the phrase "ene kemetate befit" (እኔ ከመምጣቴ በፊት) audibly on the recording. ' +
            'A clear paraphrase does not count — the phrase must be recognisable as said. ' +
            'It may be said at any point during the faceoff segment. ' +
            'Resolves NO if the faceoff takes place and the phrase is not said. ' +
            'VOIDS and refunds in full if no official footage is published, if the audio is inaudible, ' +
            'or if the faceoff does not take place.',
        outcomes: ['Yes', 'No'],
    },
]

async function main() {
    console.log(`\nSeeding ETFC 2.0 novelty markets (DRAFT)\n`)

    let created = 0
    let existing = 0

    for (const spec of MARKETS) {
        // Same idempotency key as the card seed: (eventName, question).
        const found = await prisma.predictionMarket.findFirst({
            where: { eventName: EVENT_NAME, question: spec.question },
            select: { id: true },
        })

        if (found) {
            existing += 1
            console.log(`  · already present — ${spec.question}`)
            continue
        }

        const market = await prisma.predictionMarket.create({
            data: {
                eventName: EVENT_NAME,
                question: spec.question,
                description: spec.description,
                closesAt: FACEOFF_CLOSES_AT,
                // shareValue and feePct deliberately omitted so they snapshot
                // from SiteSetting, exactly like the bout markets.
            },
            select: { id: true },
        })

        for (let sortOrder = 0; sortOrder < spec.outcomes.length; sortOrder++) {
            await prisma.predictionOutcome.create({
                data: { marketId: market.id, label: spec.outcomes[sortOrder]!, sortOrder },
            })
        }

        created += 1
        console.log(`  ✓ created — ${spec.question}`)
    }

    console.log(`\n  ${created} created, ${existing} already present.`)
    console.log(`  Closes: ${FACEOFF_CLOSES_AT.toISOString()} (17:00 Addis, 26 Aug) — verify against the official schedule.`)
    console.log(`  All DRAFT. Publish from the admin panel when you are ready.\n`)
}

main()
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
