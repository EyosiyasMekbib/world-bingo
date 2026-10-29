import crypto from 'node:crypto'

/**
 * IGCORE's go-live checklist (§7 of the protocol PDF), the OPERATOR→CLIENT
 * items: every callback IGCORE sends us and how we must answer it. Pure: it
 * reaches our callback routes only through `deps.send` and reads the player
 * only through `deps.balance`, so the same runner drives `app.inject` in the
 * db test and real HTTP from the staging simulator's `/checklist`.
 *
 * The items run one after another against ONE player whose balance carries
 * across them. Each item reads the balance when it starts and asserts its own
 * deltas, so one failure does not cascade into the rest. The player is assumed
 * to start with real 100, bonus 0 and the toggle on REAL; an item short of
 * funds tops the player up with a result on a fresh ticket first.
 */

export interface ChecklistDeps {
    send(endpoint: 'transaction' | 'transaction-rollback', body: object, opts?: { badSignature?: boolean }): Promise<{ status: number; json: any }>
    balance(): Promise<{ real: number; bonus: number }>
    playerId: string
    currency: string
}

export interface ChecklistResult {
    name: string
    pass: boolean
    detail: string
}

type Endpoint = 'transaction' | 'transaction-rollback'
type Answer = { status: number; json: any }
type Balance = { real: number; bonus: number }
type Info = { ticketId: number }

/** §7 answer budgets: bet/freebet within 5 s, result/rollback within 10 s. */
const BET_BUDGET_MS = 5000
const SETTLE_BUDGET_MS = 10_000
/** Balances are compared to the cent: the Decimal columns read back as floats. */
const EPSILON = 0.005
const STAKE = 10
const BURST = 5

/** A failed expectation inside an item. Its message becomes the item's detail. */
class CheckFailed extends Error {}

function must(condition: boolean, message: string): asserts condition {
    if (!condition) throw new CheckFailed(message)
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

function close(a: number, b: number): boolean {
    return Math.abs(a - b) < EPSILON
}

function fmt(a: Answer): string {
    return `HTTP ${a.status} ${JSON.stringify(a.json)}`
}

/** 200 `{error:null, transaction_id}` with a non-empty CLIENT id. */
function isOk(a: Answer): boolean {
    return a.status === 200 && a.json?.error === null && typeof a.json?.transaction_id === 'string' && a.json.transaction_id.length > 0
}

function isRefusal(a: Answer, code: string): boolean {
    return a.status === 200 && a.json?.error === code
}

/** A 32-hex player id nobody holds. */
function strangerId(): string {
    return crypto.randomBytes(16).toString('hex')
}

export async function runIgcoreChecklist(deps: ChecklistDeps): Promise<ChecklistResult[]> {
    // Unique per run: IGCORE's transaction_id is a fresh UUID per callback, and
    // ticket ids start at a random base so two runs never share a lineage.
    let ticketSeq = crypto.randomInt(1_000_000_000, 2_000_000_000)
    const nextTicket = () => ticketSeq++
    const newId = (): string => crypto.randomUUID()
    const timings: Array<{ action: string; ms: number }> = []

    async function send(endpoint: Endpoint, body: { action: string }, opts?: { badSignature?: boolean }): Promise<Answer> {
        const started = Date.now()
        const answer = await deps.send(endpoint, body, opts)
        timings.push({ action: body.action, ms: Date.now() - started })
        return answer
    }

    const callback = (action: 'bet' | 'result' | 'freebet', amount: number, ticketId: number, transactionId = newId(), playerId = deps.playerId) => ({
        transaction_id: transactionId, action, user_id: playerId, currency: deps.currency, amount, info: { ticketId } as Info,
    })
    const bet = (amount: number, ticketId: number, transactionId?: string, playerId?: string) => callback('bet', amount, ticketId, transactionId, playerId)
    const result = (amount: number, ticketId: number, transactionId?: string, playerId?: string) => callback('result', amount, ticketId, transactionId, playerId)
    const rollback = (original: string, action: 'bet' | 'result', ticketId: number, amount: number) => ({
        transaction_id: newId(), action: 'rollback', user_id: deps.playerId, currency: deps.currency, amount,
        rollback_transaction_id: original, rollback_transaction_action: action, info: { ticketId } as Info,
    })

    async function expectBalance(expected: Balance, what: string): Promise<void> {
        const now = await deps.balance()
        must(
            close(now.real, expected.real) && close(now.bonus, expected.bonus),
            `${what}: expected real ${round2(expected.real)} bonus ${round2(expected.bonus)}, found real ${round2(now.real)} bonus ${round2(now.bonus)}`,
        )
    }

    /**
     * Tops the player's real balance up to at least `min` with a result on a
     * fresh ticket. Never needed when every earlier item passed (the run fits
     * in the starting 100); it keeps one failure from starving later items.
     * Returns a note for the item's detail, empty when nothing was needed.
     */
    async function ensureFunds(min: number): Promise<string> {
        const { real } = await deps.balance()
        if (real >= min) return ''
        const topUp = round2(min - real + 50)
        const a = await send('transaction', result(topUp, nextTicket()))
        must(isOk(a), `top-up result of ${topUp} was not accepted: ${fmt(a)}`)
        return `topped up ${topUp} first; `
    }

    /** Places a stake on a fresh ticket and requires it accepted. */
    async function placeBet(amount: number): Promise<{ ticket: number; body: ReturnType<typeof bet>; answer: Answer }> {
        const ticket = nextTicket()
        const body = bet(amount, ticket)
        const answer = await send('transaction', body)
        must(isOk(answer), `setup bet of ${amount} answered ${fmt(answer)}`)
        return { ticket, body, answer }
    }

    const items: Array<{ name: string; run: () => Promise<string> }> = [
        {
            name: 'A callback with a wrong X-Security-Hash is rejected.',
            run: async () => {
                const start = await deps.balance()
                const ticket = nextTicket()
                const betBody = bet(1, ticket)
                const a = await send('transaction', betBody, { badSignature: true })
                must(a.status === 400 && a.json?.error === 'INVALID_SIGNATURE', `bet with a wrong hash answered ${fmt(a)}, expected HTTP 400 INVALID_SIGNATURE`)
                const r = await send('transaction-rollback', rollback(betBody.transaction_id, 'bet', ticket, 1), { badSignature: true })
                must(r.status === 400 && r.json?.error === 'INVALID_SIGNATURE', `rollback with a wrong hash answered ${fmt(r)}, expected HTTP 400 INVALID_SIGNATURE`)
                await expectBalance(start, 'after the badly signed callbacks')
                return `bet and rollback with a wrong X-Security-Hash both answered HTTP 400 INVALID_SIGNATURE; balance unchanged (real ${round2(start.real)})`
            },
        },
        {
            name: 'bet accepted: balance debited once, response carries a CLIENT transaction_id.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const start = await deps.balance()
                const body = bet(STAKE, nextTicket())
                const a = await send('transaction', body)
                must(isOk(a), `bet answered ${fmt(a)}`)
                must(a.json.transaction_id !== body.transaction_id, 'answered with IGCORE\'s own transaction_id instead of a CLIENT one')
                await expectBalance({ real: start.real - STAKE, bonus: start.bonus }, 'after the bet')
                return `${pre}stake ${STAKE} debited once (real ${round2(start.real)} → ${round2(start.real - STAKE)}); CLIENT transaction_id ${a.json.transaction_id}`
            },
        },
        {
            name: 'bet with insufficient balance: rejected with INSUFFICIENT_FUNDS, balance unchanged.',
            run: async () => {
                const start = await deps.balance()
                const amount = round2(start.real + start.bonus + 1)
                const a = await send('transaction', bet(amount, nextTicket()))
                must(isRefusal(a, 'INSUFFICIENT_FUNDS'), `bet of ${amount} against real ${round2(start.real)} answered ${fmt(a)}, expected INSUFFICIENT_FUNDS`)
                await expectBalance(start, 'after the refused bet')
                return `bet of ${amount} against real ${round2(start.real)} answered INSUFFICIENT_FUNDS; balance unchanged`
            },
        },
        {
            name: 'bet for an unknown player: rejected, no record of the player created.',
            run: async () => {
                const start = await deps.balance()
                const stranger = strangerId()
                const first = await send('transaction', bet(STAKE, nextTicket(), newId(), stranger))
                must(isRefusal(first, 'PLAYER_NOT_FOUND'), `bet for unknown player answered ${fmt(first)}, expected PLAYER_NOT_FOUND`)
                // Had the first lookup created the player, this one would resolve
                // to them and answer something else (INSUFFICIENT_FUNDS on an empty wallet).
                const second = await send('transaction', bet(STAKE, nextTicket(), newId(), stranger))
                must(isRefusal(second, 'PLAYER_NOT_FOUND'), `a second bet for the same unknown player answered ${fmt(second)}: the first appears to have created a record`)
                await expectBalance(start, 'the test player\'s balance')
                return `two bets for unknown player ${stranger.slice(0, 6)}… both answered PLAYER_NOT_FOUND, so the first created no record; test player's balance unchanged`
            },
        },
        {
            name: 'Duplicate bet (same transaction_id): success with the same CLIENT transaction_id, balance unchanged.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const start = await deps.balance()
                const body = bet(STAKE, nextTicket())
                const first = await send('transaction', body)
                must(isOk(first), `bet answered ${fmt(first)}`)
                const again = await send('transaction', body)
                must(
                    isOk(again) && again.json.transaction_id === first.json.transaction_id,
                    `duplicate bet answered ${fmt(again)}, expected the same CLIENT transaction_id ${first.json.transaction_id}`,
                )
                await expectBalance({ real: start.real - STAKE, bonus: start.bonus }, 'after the bet and its duplicate')
                return `${pre}duplicate answered the same CLIENT transaction_id ${first.json.transaction_id}; stake ${STAKE} debited once (real ${round2(start.real)} → ${round2(start.real - STAKE)})`
            },
        },
        {
            name: 'Two concurrent bet callbacks for the same player are serialised and both handled correctly.',
            run: async () => {
                const pre = await ensureFunds(20)
                const start = await deps.balance()
                // Each stake is more than half the balance: serialised, exactly one
                // fits; unserialised, both read the same balance and both pass.
                const amount = Math.floor(start.real / 2) + 1
                const answers = await Promise.all([send('transaction', bet(amount, nextTicket())), send('transaction', bet(amount, nextTicket()))])
                const accepted = answers.filter(isOk).length
                const refused = answers.filter((a) => isRefusal(a, 'INSUFFICIENT_FUNDS')).length
                must(
                    accepted === 1 && refused === 1,
                    `two concurrent bets of ${amount} against real ${round2(start.real)} answered ${answers.map(fmt).join(' and ')}; expected one accepted and one INSUFFICIENT_FUNDS`,
                )
                await expectBalance({ real: start.real - amount, bonus: start.bonus }, 'after the concurrent bets')
                return `${pre}two concurrent bets of ${amount} against real ${round2(start.real)}: one accepted, one INSUFFICIENT_FUNDS; real ${round2(start.real)} → ${round2(start.real - amount)}`
            },
        },
        {
            name: 'result credited once; duplicate result answers the same CLIENT transaction_id.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const { ticket } = await placeBet(STAKE)
                const start = await deps.balance()
                const payout = 25
                const body = result(payout, ticket)
                const first = await send('transaction', body)
                must(isOk(first), `result answered ${fmt(first)}`)
                await expectBalance({ real: start.real + payout, bonus: start.bonus }, 'after the result')
                const again = await send('transaction', body)
                must(
                    isOk(again) && again.json.transaction_id === first.json.transaction_id,
                    `duplicate result answered ${fmt(again)}, expected the same CLIENT transaction_id ${first.json.transaction_id}`,
                )
                await expectBalance({ real: start.real + payout, bonus: start.bonus }, 'after the duplicate result')
                return `${pre}payout ${payout} credited once (real ${round2(start.real)} → ${round2(start.real + payout)}); duplicate answered the same CLIENT transaction_id ${first.json.transaction_id}`
            },
        },
        {
            name: 'result with amount: 0 (loss with sendLose, freebet loss) is recorded and answered with success.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const { ticket } = await placeBet(STAKE)
                const start = await deps.balance()
                const a = await send('transaction', result(0, ticket))
                must(isOk(a), `result of 0 answered ${fmt(a)}`)
                await expectBalance(start, 'after the 0 result')
                return `${pre}result of 0 on a lost ticket answered success (CLIENT transaction_id ${a.json.transaction_id}); balance unchanged (real ${round2(start.real)}). Freebets are off, so there is no freebet loss to send`
            },
        },
        {
            name: 'rollback of a bet: stake credited back; duplicate rollback is idempotent.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const start = await deps.balance()
                const { ticket, body } = await placeBet(STAKE)
                await expectBalance({ real: start.real - STAKE, bonus: start.bonus }, 'after the bet')
                const rb = rollback(body.transaction_id, 'bet', ticket, STAKE)
                const first = await send('transaction-rollback', rb)
                must(isOk(first), `rollback answered ${fmt(first)}`)
                await expectBalance(start, 'after the rollback')
                const again = await send('transaction-rollback', rb)
                must(
                    isOk(again) && again.json.transaction_id === first.json.transaction_id,
                    `duplicate rollback answered ${fmt(again)}, expected the same CLIENT transaction_id ${first.json.transaction_id}`,
                )
                await expectBalance(start, 'after the duplicate rollback')
                return `${pre}stake ${STAKE} debited then credited back (real ${round2(start.real)} → ${round2(start.real - STAKE)} → ${round2(start.real)}); duplicate rollback answered the same CLIENT transaction_id and moved nothing`
            },
        },
        {
            name: 'rollback of a result followed by a new result: payout debited, then the corrected payout credited.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const { ticket } = await placeBet(STAKE)
                const wrong = 30
                const corrected = 20
                const resultBody = result(wrong, ticket)
                const paid = await send('transaction', resultBody)
                must(isOk(paid), `result answered ${fmt(paid)}`)
                const start = await deps.balance()
                const rb = await send('transaction-rollback', rollback(resultBody.transaction_id, 'result', ticket, wrong))
                must(isOk(rb), `result rollback answered ${fmt(rb)}`)
                await expectBalance({ real: start.real - wrong, bonus: start.bonus }, 'after the result rollback')
                const fixed = await send('transaction', result(corrected, ticket))
                must(isOk(fixed), `corrected result answered ${fmt(fixed)}`)
                await expectBalance({ real: start.real - wrong + corrected, bonus: start.bonus }, 'after the corrected result')
                return `${pre}payout ${wrong} rolled back (real ${round2(start.real)} → ${round2(start.real - wrong)}), corrected payout ${corrected} credited (→ ${round2(start.real - wrong + corrected)})`
            },
        },
        {
            name: 'rollback whose rollback_transaction_id is unknown: two records created, balance unchanged, success answered.',
            run: async () => {
                const pre = await ensureFunds(STAKE)
                const start = await deps.balance()
                const ticket = nextTicket()
                const missing = newId()
                const a = await send('transaction-rollback', rollback(missing, 'bet', ticket, STAKE))
                must(isOk(a), `rollback of an unknown transaction answered ${fmt(a)}`)
                await expectBalance(start, 'after the rollback')
                // The second record is the placeholder under the unknown id. The
                // bet arriving late with that id is answered from it: success, its
                // own row, nothing debited.
                const late = await send('transaction', bet(STAKE, ticket, missing))
                must(isOk(late), `the late original bet answered ${fmt(late)}, expected success from the placeholder`)
                must(late.json.transaction_id !== a.json.transaction_id, 'the late original bet answered the rollback\'s own row: no separate placeholder record')
                await expectBalance(start, 'after the late original bet')
                return `${pre}rollback answered success (CLIENT transaction_id ${a.json.transaction_id}); the late original then answered from its own placeholder record ${late.json.transaction_id} with no debit, so two records exist; balance unchanged (real ${round2(start.real)})`
            },
        },
        {
            name: 'A result the CLIENT cannot process is answered with a 5xx status (never 200 with an error) and is processed correctly on the retry.',
            run: async () => {
                const start = await deps.balance()
                const a = await send('transaction', result(STAKE, nextTicket(), newId(), strangerId()))
                must(a.status === 500, `result for an unknown player answered ${fmt(a)}, expected HTTP 500`)
                await expectBalance(start, 'the test player\'s balance')
                return `a result for an unknown player answered ${fmt(a)}, never 200. The retry half needs a transient fault that cannot be staged at runtime; it is covered by the db test "raised cap releases a held payout once"`
            },
        },
        {
            // Run last (see the loop below), so the verdict covers every callback of the run.
            name: 'Callback responses arrive well within 5 s for bet/freebet and 10 s for result/rollback under expected load.',
            run: async () => {
                const problems: string[] = []
                // A small concurrent burst, so the budgets are also measured under
                // some load and not only one call at a time.
                const pre = await ensureFunds(BURST)
                const start = await deps.balance()
                const tickets = Array.from({ length: BURST }, () => nextTicket())
                const bets = await Promise.all(tickets.map((t) => send('transaction', bet(1, t))))
                const results = await Promise.all(tickets.map((t) => send('transaction', result(1, t))))
                const failed = [...bets, ...results].filter((a) => !isOk(a))
                if (failed.length > 0) problems.push(`burst answers not accepted: ${failed.map(fmt).join('; ')}`)
                else {
                    const now = await deps.balance()
                    if (!close(now.real, start.real) || !close(now.bonus, start.bonus)) {
                        problems.push(`burst of ${BURST} bets of 1 and ${BURST} results of 1 moved real ${round2(start.real)} → ${round2(now.real)}, expected no net change`)
                    }
                }

                const slowest = (actions: string[]) => Math.max(0, ...timings.filter((t) => actions.includes(t.action)).map((t) => t.ms))
                const betMs = slowest(['bet', 'freebet'])
                const settleMs = slowest(['result', 'rollback'])
                const verdict = (ms: number, budget: number) => `${ms} ms (${ms > budget ? 'over' : 'within'} the ${budget} ms budget)`
                const summary = `slowest bet/freebet ${verdict(betMs, BET_BUDGET_MS)}; slowest result/rollback ${verdict(settleMs, SETTLE_BUDGET_MS)}`
                if (betMs > BET_BUDGET_MS || settleMs > SETTLE_BUDGET_MS) problems.push(summary)
                must(problems.length === 0, problems.join('; '))
                return `${pre}${timings.length} callbacks timed, including a burst of ${BURST} concurrent bets and ${BURST} concurrent results; ${summary}`
            },
        },
        {
            name: 'freebet placement is refused while freebets are off',
            run: async () => {
                const start = await deps.balance()
                const a = await send('transaction', callback('freebet', STAKE, nextTicket()))
                must(isRefusal(a, 'FREEBETS_NOT_ENABLED'), `freebet answered ${fmt(a)}, expected FREEBETS_NOT_ENABLED`)
                await expectBalance(start, 'after the freebet')
                return `freebet answered FREEBETS_NOT_ENABLED; nothing debited (real ${round2(start.real)})`
            },
        },
    ]

    async function runItem(item: (typeof items)[number]): Promise<ChecklistResult> {
        const started = Date.now()
        try {
            const detail = await item.run()
            return { name: item.name, pass: true, detail: `${detail} (${Date.now() - started} ms)` }
        } catch (err) {
            const reason = err instanceof CheckFailed ? err.message : `error: ${(err as Error)?.message ?? String(err)}`
            return { name: item.name, pass: false, detail: `${reason} (${Date.now() - started} ms)` }
        }
    }

    // The timing item runs after every other item, so it judges all of the
    // run's callbacks, the freebet included; results keep the PDF's order.
    const timingIndex = 12
    const results: ChecklistResult[] = new Array(items.length)
    for (let i = 0; i < items.length; i++) {
        if (i !== timingIndex) results[i] = await runItem(items[i])
    }
    results[timingIndex] = await runItem(items[timingIndex])
    return results
}
