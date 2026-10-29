import crypto from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { AccountStatus, PaymentStatus, TransactionType } from '@world-bingo/shared-types'
import prisma from '../../lib/prisma.js'
import redis from '../../lib/redis.js'
import { igcoreConfig } from '../../gateways/igcore/igcore-config.js'
import { signIgcoreBody } from '../../gateways/igcore/igcore-signature.js'
import { runIgcoreChecklist, type ChecklistDeps } from '../../gateways/igcore/igcore-checklist.js'
import { BOOK_CSP, bookPageHtml } from './book-page.js'

/**
 * STAGING ONLY. Plays IGCORE's side over real HTTP so the sportsbook can be
 * clicked through and the §7 checklist proven before IGCORE issues
 * credentials. Mounted under /v1/igcore-sim by index.ts only when
 * IGCORE_SIMULATOR=true, which only the staging compose file declares: the
 * book and /checklist mint wallet credit.
 *
 * Pointing IGCORE_API_URL at `<this API>/v1/igcore-sim` makes the real
 * IgcoreClient authenticate and open sessions here. The book then fires
 * callbacks, signed with IGCORE_SECURITY_HASH, at IGCORE_SIM_CALLBACK_URL
 * (our own /v1/igcore routes), so signature checking, routing and the wallet
 * are exercised exactly as IGCORE will exercise them.
 *
 * Answers mirror IGCORE (§3.1, §3.3): refusals are HTTP 200 `{ error }`.
 */

/** Tokens, sessions and tickets all live as long as an IGCORE token (§3.1). */
const TTL_S = 21600
const TOKEN_PREFIX = 'igcore-sim:token:'
const SESSION_PREFIX = 'igcore-sim:session:'
const TICKET_PREFIX = 'igcore-sim:ticket:'
const TICKET_SEQ = 'igcore-sim:ticket-seq'
/** Longer than the 10 s result budget, so a slow answer shows up as slow rather than as a timeout. */
const CALLBACK_TIMEOUT_MS = 15_000
const CHECKLIST_START_BALANCE = 100

type Endpoint = 'transaction' | 'transaction-rollback'
type CallbackAnswer = { status: number; json: any }
type SimSession = { user_id: string; currency: string }
type SimTicket = {
    id: number
    user_id: string
    currency: string
    stake: number
    odds: number
    /** The ticket this one is the remainder of after a partial cashout. */
    fromId: number | null
    status: 'open' | 'settled' | 'cashed'
    resultTxId?: string
}

const OPS = ['bet', 'settle-win', 'settle-lose', 'cashout', 'rollback-settlement', 'late-bet'] as const
type Op = (typeof OPS)[number]

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

/**
 * Signs the exact bytes and POSTs them to our callback routes, the way IGCORE
 * does. Never throws: a transport failure comes back as status 0 so the book
 * and the checklist can show it.
 */
async function postCallback(endpoint: Endpoint, body: object, opts: { badSignature?: boolean } = {}): Promise<CallbackAnswer> {
    const cfg = igcoreConfig()
    const raw = JSON.stringify(body)
    const hash = signIgcoreBody(raw, opts.badSignature ? `${cfg.securityHash}:wrong` : cfg.securityHash)
    try {
        const res = await fetch(`${cfg.simCallbackUrl.replace(/\/+$/, '')}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Security-Hash': hash },
            body: raw,
            signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        })
        const text = await res.text()
        let json: unknown = text
        try {
            json = text ? JSON.parse(text) : null
        } catch {
            // Not JSON: keep the text so it is visible.
        }
        return { status: res.status, json }
    } catch (err: any) {
        return { status: 0, json: { error: `UNREACHABLE: ${err?.message ?? 'network error'}` } }
    }
}

function accepted(a: CallbackAnswer): boolean {
    return a.status === 200 && a.json?.error === null
}

function bearerOf(header: string | undefined): string | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
    return match ? match[1] : null
}

async function readJson<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key)
    if (!raw) return null
    try {
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

async function saveTicket(t: SimTicket): Promise<void> {
    await redis.setex(`${TICKET_PREFIX}${t.id}`, TTL_S, JSON.stringify(t))
}

/** A finite number within bounds, else null. */
function numberIn(raw: unknown, min: number, max: number, inclusiveMin = true): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
    if (raw > max || raw < min || (!inclusiveMin && raw === min)) return null
    return raw
}

/** What IGCORE puts in `info` for a ticket: its id, plus its lineage when it is a remainder. */
function ticketInfo(t: SimTicket): Record<string, unknown> {
    return t.fromId == null ? { ticketId: t.id } : { ticketId: t.id, ticket: { id: t.id, fromId: t.fromId } }
}

export const igcoreSimRoutes: FastifyPluginAsync = async (fastify) => {
    // ── §3.1 auth ─────────────────────────────────────────────────────────────
    fastify.post('/1.0.0/auth', async (req) => {
        const cfg = igcoreConfig()
        const body = (req.body ?? {}) as { username?: unknown; password?: unknown }
        // Unset credentials never match, not even an empty pair.
        if (!cfg.username || !cfg.password || body.username !== cfg.username || body.password !== cfg.password) {
            return { error: 'invalid credentials' }
        }
        const token = crypto.randomBytes(32).toString('hex')
        await redis.setex(`${TOKEN_PREFIX}${token}`, TTL_S, '1')
        return { token, expires_in: TTL_S }
    })

    // ── §3.3 start-session ────────────────────────────────────────────────────
    fastify.post('/1.0.0/start-session', async (req) => {
        const cfg = igcoreConfig()
        const token = bearerOf(req.headers.authorization)
        if (!token || !(await redis.get(`${TOKEN_PREFIX}${token}`))) return { error: 'Unauthorized' }

        const body = (req.body ?? {}) as { user_id?: unknown; currency?: unknown; lang?: unknown }
        if (body.currency !== cfg.currency) return { error: 'currency is not allowed' }
        if (typeof body.user_id !== 'string' || !body.user_id) return { error: 'invalid params' }

        const id = crypto.randomUUID()
        const session: SimSession = { user_id: body.user_id, currency: cfg.currency }
        await redis.setex(`${SESSION_PREFIX}${id}`, TTL_S, JSON.stringify(session))
        const lang = typeof body.lang === 'string' && body.lang ? body.lang : cfg.defaultLang
        return { url: `${cfg.simPublicUrl.replace(/\/+$/, '')}/v1/igcore-sim/book?s=${id}&lang=${encodeURIComponent(lang)}` }
    })

    // ── The book (the iframe page) ────────────────────────────────────────────
    fastify.get('/book', async (req, reply) => {
        const q = (req.query ?? {}) as { s?: unknown; lang?: unknown }
        const s = typeof q.s === 'string' ? q.s : ''
        const lang = typeof q.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(q.lang) ? q.lang : igcoreConfig().defaultLang
        const session = s ? await readJson<SimSession>(`${SESSION_PREFIX}${s}`) : null

        // Helmet (index.ts) writes X-Frame-Options and a CSP with
        // `frame-ancestors 'self'` straight onto the raw response in production,
        // and the book must render in the web app's iframe on another origin.
        // reply.removeHeader only clears Fastify's own header map, so the raw
        // header is removed too; reply.header replaces Helmet's CSP when the
        // headers are written.
        reply.removeHeader('x-frame-options')
        reply.raw.removeHeader('x-frame-options')
        reply.header('Content-Security-Policy', BOOK_CSP)
        reply.type('text/html; charset=utf-8')

        if (!session) return reply.status(404).send(bookPageHtml({ session: null, lang }))
        return reply.send(bookPageHtml({ session: s, lang, currency: session.currency }))
    })

    // ── Book buttons: each fires the matching signed callback ─────────────────
    fastify.post('/book/action', async (req, reply) => {
        const body = (req.body ?? {}) as { s?: unknown; op?: unknown; stake?: unknown; odds?: unknown; ticketId?: unknown; portion?: unknown }
        const op = body.op as Op
        if (!OPS.includes(op)) return reply.status(400).send({ error: 'unknown op' })

        const session = typeof body.s === 'string' && body.s ? await readJson<SimSession>(`${SESSION_PREFIX}${body.s}`) : null
        if (!session) return reply.status(404).send({ error: 'unknown session' })

        const base = { user_id: session.user_id, currency: session.currency }

        if (op === 'bet' || op === 'late-bet') {
            const stake = numberIn(body.stake, 0, 1_000_000, false)
            const odds = numberIn(body.odds, 1, 1000)
            if (stake == null || odds == null) return reply.status(400).send({ error: 'stake must be > 0 and odds >= 1' })

            const id = await redis.incr(TICKET_SEQ)
            const ticket: SimTicket = { id, ...base, stake: round2(stake), odds, fromId: null, status: 'open' }
            const sentBet = { transaction_id: crypto.randomUUID(), action: 'bet', ...base, amount: ticket.stake, info: ticketInfo(ticket) }
            const betAnswer = await postCallback('transaction', sentBet)

            if (op === 'bet') {
                if (accepted(betAnswer)) await saveTicket(ticket)
                return { sent: sentBet, response: betAnswer }
            }

            // Our answer "arrived too late": IGCORE cancels the bet and queues its rollback.
            const sentRollback = {
                transaction_id: crypto.randomUUID(), action: 'rollback', ...base, amount: ticket.stake,
                rollback_transaction_id: sentBet.transaction_id, rollback_transaction_action: 'bet', info: ticketInfo(ticket),
            }
            const rollbackAnswer = await postCallback('transaction-rollback', sentRollback)
            return { sent: [sentBet, sentRollback], response: [betAnswer, rollbackAnswer] }
        }

        const ticketId = typeof body.ticketId === 'number' && Number.isInteger(body.ticketId) ? body.ticketId : null
        const ticket = ticketId == null ? null : await readJson<SimTicket>(`${TICKET_PREFIX}${ticketId}`)
        // Another session player's ticket is as good as unknown.
        if (!ticket || ticket.user_id !== session.user_id) return reply.status(404).send({ error: 'unknown ticket' })

        if (op === 'rollback-settlement') {
            if (ticket.status !== 'settled' || !ticket.resultTxId) return reply.status(409).send({ error: `ticket is ${ticket.status}, not settled` })
            // A wrong settlement reversed; the corrected result follows (§4.9), so the ticket reopens.
            const sent = {
                transaction_id: crypto.randomUUID(), action: 'rollback', ...base, amount: 0,
                rollback_transaction_id: ticket.resultTxId, rollback_transaction_action: 'result', info: ticketInfo(ticket),
            }
            const response = await postCallback('transaction-rollback', sent)
            if (accepted(response)) await saveTicket({ ...ticket, status: 'open', resultTxId: undefined })
            return { sent, response }
        }

        if (ticket.status !== 'open') return reply.status(409).send({ error: `ticket is ${ticket.status}, not open` })

        if (op === 'cashout') {
            const portion = body.portion === undefined ? 1 : numberIn(body.portion, 0, 1, false)
            if (portion == null) return reply.status(400).send({ error: 'portion must be > 0 and <= 1' })
            const payout = round2(ticket.stake * ticket.odds * portion)
            // A partial cashout splits off a remainder ticket that keeps the
            // unsold stake; IGCORE names it in info.newTicket.
            const remainder: SimTicket | null = portion < 1
                ? { id: await redis.incr(TICKET_SEQ), ...base, stake: round2(ticket.stake * (1 - portion)), odds: ticket.odds, fromId: ticket.id, status: 'open' }
                : null
            const info = remainder ? { ...ticketInfo(ticket), newTicket: { id: remainder.id, fromId: ticket.id } } : ticketInfo(ticket)
            const sent = { transaction_id: crypto.randomUUID(), action: 'result', ...base, amount: payout, info }
            const response = await postCallback('transaction', sent)
            if (accepted(response)) {
                await saveTicket({ ...ticket, status: 'cashed', resultTxId: sent.transaction_id })
                if (remainder) await saveTicket(remainder)
            }
            return { sent, response }
        }

        // settle-win / settle-lose. A loss is sent as 0 (sendLose).
        const payout = op === 'settle-win' ? round2(ticket.stake * ticket.odds) : 0
        const sent = { transaction_id: crypto.randomUUID(), action: 'result', ...base, amount: payout, info: ticketInfo(ticket) }
        const response = await postCallback('transaction', sent)
        if (accepted(response)) await saveTicket({ ...ticket, status: 'settled', resultTxId: sent.transaction_id })
        return { sent, response }
    })

    // ── §7 checklist against a throwaway player ───────────────────────────────
    fastify.post('/checklist', { preValidation: [fastify.requireAdmin] }, async (req, reply) => {
        const cfg = igcoreConfig()
        if (!cfg.securityHash) return reply.status(503).send({ error: 'IGCORE_SECURITY_HASH is not set: every callback would be rejected' })

        // A fresh player per run, so items never inherit another run's tickets.
        // Neither the password marker (not a bcrypt hash) nor the `+000` phone
        // (no such country code) can be used to log in or to reach a real person.
        const stamp = Date.now()
        const user = await prisma.user.create({
            data: {
                username: `igcore-check-${stamp}`,
                phone: `+000${stamp}`,
                passwordHash: 'IGCORE_CHECKLIST_ACCOUNT',
                accountStatus: AccountStatus.ACTIVE,
                wallet: { create: { realBalance: CHECKLIST_START_BALANCE } },
                // The starting balance is minted, so it gets its audit row like any other wallet change.
                transactions: {
                    create: {
                        type: TransactionType.ADMIN_REAL_ADJUSTMENT, amount: CHECKLIST_START_BALANCE, status: PaymentStatus.APPROVED,
                        note: 'IGCORE simulator checklist: starting balance',
                        balanceBefore: 0, balanceAfter: CHECKLIST_START_BALANCE, bonusBalanceBefore: 0, bonusBalanceAfter: 0,
                    },
                },
            },
            select: { id: true, username: true },
        })

        const deps: ChecklistDeps = {
            playerId: user.id.replace(/-/g, ''),
            currency: cfg.currency,
            send: (endpoint, body, opts) => postCallback(endpoint, body, opts),
            balance: async () => {
                const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id }, select: { realBalance: true, bonusBalance: true } })
                return { real: w.realBalance.toNumber(), bonus: w.bonusBalance.toNumber() }
            },
        }

        const results = await runIgcoreChecklist(deps)
        const failed = results.filter((r) => !r.pass).length
        const passed = results.length - failed
        req.log.info({ component: 'igcore-sim', username: user.username, passed, failed }, '[igcore-sim] checklist run')
        return { passed, failed, results }
    })
}
