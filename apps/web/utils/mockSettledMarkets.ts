/**
 * MOCK settled markets — a local preview of what a busy platform looks like.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS REAL AND NONE OF IT IS PERSISTED.
 *
 * These markets were never traded, the volumes were never staked and the
 * winners never won anything. It exists so the past-results section can be
 * designed and reviewed against realistic density instead of an empty page.
 *
 * It is gated on `import.meta.dev`, which Vite replaces with a literal at build
 * time — so in any production build the guard is `if (false)`, the array is
 * unreachable, and the bundler drops this data entirely. That is deliberate:
 * invented trading history rendered to real bettors would be fabricated social
 * proof, and a compile-time guard is the only kind that cannot be forgotten.
 *
 * If this ever needs to ship to real users, it does not. Generate the section
 * from settled markets the API actually returns.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface MockSettledMarket {
    id: string
    eventName: string
    question: string
    /** Matches the real `description` convention so `boutMetaOf` can parse it. */
    description: string
    outcomes: [string, string]
    /** Index of the outcome that won. */
    winner: 0 | 1
    /** Total ETB matched across the market's life. */
    volume: number
    /** Shares matched. volume === shares × 100. */
    shares: number
    /** Distinct accounts that traded it. */
    traders: number
    /** Largest single payout, in ETB. */
    topPayout: number
    /** Days ago it settled. */
    settledDaysAgo: number
    /**
     * The winning outcome's price path in whole birr, oldest first. Drifts
     * toward the result the way a real book converges as information arrives.
     */
    path: number[]
}

const MARKETS: MockSettledMarket[] = [
    {
        id: 'mock-etfc1-main',
        eventName: 'ETFC Fight Night 1.0',
        question: 'Sofiya "The Hammer" vs Dani "Cobra" — who wins?',
        description: 'MMA — Welterweight, 5 rounds — Main Event',
        outcomes: ['Sofiya "The Hammer"', 'Dani "Cobra"'],
        winner: 0,
        volume: 1_284_600,
        shares: 12_846,
        traders: 418,
        topPayout: 96_400,
        settledDaysAgo: 96,
        path: [44, 48, 46, 53, 57, 55, 62, 66, 64, 71, 75, 78, 82, 79, 88],
    },
    {
        id: 'mock-etfc1-box',
        eventName: 'ETFC Fight Night 1.0',
        question: 'Mikiyas vs Tewodros — who wins?',
        description: 'Boxing — 67 kg, 6 rounds',
        outcomes: ['Mikiyas', 'Tewodros'],
        winner: 1,
        volume: 742_300,
        shares: 7_423,
        traders: 260,
        topPayout: 51_800,
        settledDaysAgo: 96,
        path: [42, 45, 40, 48, 53, 51, 58, 62, 60, 67, 71, 75, 79, 84],
    },
    {
        id: 'mock-etfc1-mt',
        eventName: 'ETFC Fight Night 1.0',
        question: 'Hayat vs Ruth — who wins?',
        description: 'Muay Thai — 54 kg, 5 rounds',
        outcomes: ['Hayat', 'Ruth'],
        winner: 0,
        volume: 511_900,
        shares: 5_119,
        traders: 187,
        topPayout: 38_200,
        settledDaysAgo: 96,
        path: [50, 54, 51, 58, 61, 59, 65, 68, 72, 70, 76, 83],
    },
    {
        id: 'mock-ger-10k',
        eventName: 'Great Ethiopian Run',
        question: 'Does an Ethiopian win the Great Ethiopian Run 10K?',
        description: 'Athletics — Addis Ababa',
        outcomes: ['Yes', 'No'],
        winner: 0,
        volume: 1_106_800,
        shares: 11_068,
        traders: 502,
        topPayout: 61_500,
        settledDaysAgo: 61,
        path: [72, 75, 74, 79, 82, 80, 85, 88, 91, 89, 94],
    },
    {
        id: 'mock-walia',
        eventName: 'Walia Ibex',
        question: 'Do the Walia Ibex keep a clean sheet at home?',
        description: 'Football — Ethiopia national team',
        outcomes: ['Yes', 'No'],
        winner: 1,
        volume: 1_473_200,
        shares: 14_732,
        traders: 631,
        topPayout: 88_900,
        settledDaysAgo: 44,
        path: [54, 57, 53, 60, 64, 61, 67, 71, 69, 76, 80],
    },
    {
        id: 'mock-addis-rain',
        eventName: 'Addis Weather',
        question: 'Does it rain in Addis Ababa on Meskel eve?',
        description: 'Weather — Addis Ababa',
        outcomes: ['Yes', 'No'],
        winner: 0,
        volume: 623_400,
        shares: 6_234,
        traders: 294,
        topPayout: 29_700,
        settledDaysAgo: 30,
        path: [61, 64, 62, 68, 71, 69, 74, 77, 80, 86],
    },
]

/**
 * The mock set — empty in any non-dev build.
 *
 * The guard is first so the whole array is dead code once `import.meta.dev` is
 * folded to `false`.
 */
export function mockSettledMarkets(): MockSettledMarket[] {
    if (!import.meta.dev) return []
    return MARKETS
}

/** Totals for the summary strip. Zero when the mock is off. */
export function mockSettledTotals() {
    const markets = mockSettledMarkets()
    return {
        count: markets.length,
        volume: markets.reduce((sum, m) => sum + m.volume, 0),
        traders: markets.reduce((sum, m) => sum + m.traders, 0),
    }
}
