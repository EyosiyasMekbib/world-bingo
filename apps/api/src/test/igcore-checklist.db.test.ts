import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

// Redis is not running in this environment. `resolveUser` reads/writes the
// `tp:user:igcore:` cache through it; mock it like igcore-wallet.db.test.ts so
// every lookup falls through to the DB.
vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))
vi.mock('../lib/posthog-events.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/posthog-events.js')>()),
    emitProviderBet: vi.fn(),
    emitProviderWin: vi.fn(),
}))

import { prisma, expectInvariantClean } from './setup'
import { signIgcoreBody } from '../gateways/igcore/igcore-signature.js'
import { igcoreCallbackRoutes } from '../routes/igcore/callback.js'
import { runIgcoreChecklist, type ChecklistDeps } from '../gateways/igcore/igcore-checklist.js'

const SECRET = 'checklist-secret'

/**
 * §7 of the protocol PDF, the OPERATOR→CLIENT items, verbatim. Item 14 is
 * renamed: freebets are off on this account, so the item proves they are refused.
 */
const ITEMS = [
    'A callback with a wrong X-Security-Hash is rejected.',
    'bet accepted: balance debited once, response carries a CLIENT transaction_id.',
    'bet with insufficient balance: rejected with INSUFFICIENT_FUNDS, balance unchanged.',
    'bet for an unknown player: rejected, no record of the player created.',
    'Duplicate bet (same transaction_id): success with the same CLIENT transaction_id, balance unchanged.',
    'Two concurrent bet callbacks for the same player are serialised and both handled correctly.',
    'result credited once; duplicate result answers the same CLIENT transaction_id.',
    'result with amount: 0 (loss with sendLose, freebet loss) is recorded and answered with success.',
    'rollback of a bet: stake credited back; duplicate rollback is idempotent.',
    'rollback of a result followed by a new result: payout debited, then the corrected payout credited.',
    'rollback whose rollback_transaction_id is unknown: two records created, balance unchanged, success answered.',
    'A result the CLIENT cannot process is answered with a 5xx status (never 200 with an error) and is processed correctly on the retry.',
    'Callback responses arrive well within 5 s for bet/freebet and 10 s for result/rollback under expected load.',
    'freebet placement is refused while freebets are off',
]

async function createPlayer() {
    return prisma.user.create({
        data: {
            username: 'igc-checklist',
            phone: '+251710000999',
            passwordHash: 'x',
            accountStatus: 'ACTIVE',
            wallet: { create: { realBalance: 100 } },
        },
    })
}

/** A CLIENT that answers success to everything and never moves money. */
function yesManDeps(overrides: Partial<ChecklistDeps> = {}): ChecklistDeps {
    return {
        playerId: 'a'.repeat(32),
        currency: 'ETB',
        send: async () => ({ status: 200, json: { error: null, transaction_id: 'same-row' } }),
        balance: async () => ({ real: 100, bonus: 0 }),
        ...overrides,
    }
}

describe('IGCORE go-live checklist against the real callback routes (real DB)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('IGCORE_SECURITY_HASH', SECRET)
        vi.stubEnv('IGCORE_CURRENCY', 'ETB')
        vi.stubEnv('IGCORE_CALLBACK_DEBUG', 'false')
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await expectInvariantClean()
    })

    it('passes every OPERATOR→CLIENT item of §7', async () => {
        const app = Fastify()
        await app.register(igcoreCallbackRoutes, { prefix: '/v1/igcore' })
        const user = await createPlayer()

        const deps: ChecklistDeps = {
            playerId: user.id.replace(/-/g, ''),
            currency: 'ETB',
            async send(endpoint, body, opts) {
                const raw = JSON.stringify(body)
                const hash = signIgcoreBody(raw, opts?.badSignature ? `${SECRET}-wrong` : SECRET)
                const res = await app.inject({
                    method: 'POST',
                    url: `/v1/igcore/${endpoint}`,
                    headers: { 'content-type': 'application/json', 'x-security-hash': hash },
                    payload: raw,
                })
                return { status: res.statusCode, json: res.json() }
            },
            async balance() {
                const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
                return { real: w.realBalance.toNumber(), bonus: w.bonusBalance.toNumber() }
            },
        }

        const results = await runIgcoreChecklist(deps)

        expect(results).toHaveLength(14)
        expect(results.map((r) => r.name)).toEqual(ITEMS)
        expect(results.filter((r) => !r.pass)).toEqual([])
        for (const r of results) expect(r.detail).toMatch(/\d+ ms\)$/)
        expect(results[11].detail).toContain('raised cap releases a held payout once')
        await app.close()
    })
})

describe('IGCORE go-live checklist verdicts', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('fails a CLIENT that answers success to everything', async () => {
        const results = await runIgcoreChecklist(yesManDeps())

        expect(results.map((r) => r.name)).toEqual(ITEMS)
        // Only the two items such a CLIENT happens to satisfy: a 0 result moves
        // nothing, and the burst it answers fast with nothing moved nets to zero.
        expect(results.filter((r) => r.pass).map((r) => r.name)).toEqual([ITEMS[7], ITEMS[12]])
        expect(results[0].detail).toContain('INVALID_SIGNATURE')
        expect(results[11].detail).toContain('500')
    })

    it('fails the timing item when a bet answers in over 5 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const send: ChecklistDeps['send'] = async (_endpoint, body) => {
            if ((body as { action?: string }).action === 'bet') vi.setSystemTime(Date.now() + 6000)
            return { status: 200, json: { error: null, transaction_id: 'same-row' } }
        }

        const results = await runIgcoreChecklist(yesManDeps({ send }))

        expect(results[12].pass).toBe(false)
        expect(results[12].detail).toMatch(/bet\/freebet \d+ ms \(over the 5000 ms budget\)/)
        expect(results[12].detail).toMatch(/result\/rollback \d+ ms \(within the 10000 ms budget\)/)
    })

    it('fails the timing item when a result answers in over 10 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const send: ChecklistDeps['send'] = async (_endpoint, body) => {
            if ((body as { action?: string }).action === 'result') vi.setSystemTime(Date.now() + 11_000)
            return { status: 200, json: { error: null, transaction_id: 'same-row' } }
        }

        const results = await runIgcoreChecklist(yesManDeps({ send }))

        expect(results[12].pass).toBe(false)
        expect(results[12].detail).toMatch(/result\/rollback \d+ ms \(over the 10000 ms budget\)/)
        expect(results[12].detail).toMatch(/bet\/freebet \d+ ms \(within the 5000 ms budget\)/)
    })

    it('records a thrown send as a failed item and carries on', async () => {
        const send: ChecklistDeps['send'] = async () => {
            throw new Error('connect ECONNREFUSED')
        }

        const results = await runIgcoreChecklist(yesManDeps({ send }))

        expect(results).toHaveLength(14)
        expect(results.every((r) => !r.pass)).toBe(true)
        expect(results[1].detail).toContain('ECONNREFUSED')
    })
})
