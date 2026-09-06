/**
 * Pure row → PostHog event mappers for scripts/posthog-backfill.ts.
 *
 * Every event carries a DETERMINISTIC uuid (v5 over "source:id:event"), so
 * re-running the script after a partial failure adds nothing twice: PostHog
 * de-duplicates on uuid. Every event also carries `backfilled: true`.
 *
 * `transactions` has no decision timestamp, only createdAt. Backfilled
 * approved/rejected events are therefore stamped createdAt + 1 s (so they sort
 * after the submit) and carry `hours_to_*: null`. Decision timing is a
 * live-only metric.
 */
import { createHash } from 'crypto'
import { gameOutcomeEvents, personPropsFor, withdrawalMethodFromNote } from './posthog-events'

/** Fixed namespace so uuids are stable across machines and runs. */
export const BACKFILL_NAMESPACE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

export function deterministicUuid(name: string, namespace: string = BACKFILL_NAMESPACE): string {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
    const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
    hash[6] = (hash[6] & 0x0f) | 0x50 // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80 // RFC 4122 variant
    const hex = hash.subarray(0, 16).toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export interface BackfillEvent {
    distinctId: string
    event: string
    properties: Record<string, unknown>
    timestamp: Date
    uuid: string
}

export interface BackfillAlias {
    distinctId: string
    alias: string
}

export interface UserRow {
    id: string
    serial: number
    telegramId: string | null
    referredById: string | null
    createdAt: Date
}

export interface TxRow {
    id: string
    userId: string
    type: string
    amount: unknown
    status: string
    note: string | null
    gateway: string | null
    referenceId: string | null
    createdAt: Date
}

export interface GameRow {
    id: string
    templateId: string | null
    ticketPrice: unknown
    houseEdgePct: unknown
    status: string
    winnerId: string | null
    createdAt: Date
    startedAt: Date | null
    endedAt: Date | null
}

export interface Entrant {
    userId: string
    cartelas: number
    firstJoinedAt: Date
}

export interface AnalyticsRow {
    id: string
    name: string
    userId: string | null
    anonId: string | null
    createdAt: Date
    props: unknown
}

export const BONUS_SOURCE_BY_TYPE: Record<string, string> = {
    FIRST_DEPOSIT_BONUS: 'FIRST_DEPOSIT',
    CASHBACK_BONUS: 'CASHBACK',
    CAMPAIGN_BONUS: 'CAMPAIGN',
    ADMIN_BONUS_ADJUSTMENT: 'ADMIN',
}

function make(source: string, id: string, event: string, distinctId: string, timestamp: Date, properties: Record<string, unknown>): BackfillEvent {
    return {
        distinctId,
        event,
        properties: { ...properties, backfilled: true },
        timestamp,
        uuid: deterministicUuid(`${source}:${id}:${event}`),
    }
}

function plusOneSecond(d: Date): Date {
    return new Date(d.getTime() + 1000)
}

export function userEvents(u: UserRow): BackfillEvent[] {
    const signupMethod = u.telegramId ? 'telegram' : 'phone'
    return [
        make('user', u.id, 'user_registered', u.id, u.createdAt, {
            signup_method: signupMethod,
            referred: u.referredById !== null,
            $set: personPropsFor(u, signupMethod),
        }),
    ]
}

export function depositEvents(t: TxRow, knownMethods: Set<string>): BackfillEvent[] {
    const method = t.note && knownMethods.has(t.note) ? t.note : null
    const gateway = t.gateway ?? 'manual'
    const amount = Number(t.amount)
    const events = [
        make('tx', t.id, 'deposit_submitted', t.userId, t.createdAt, { amount, method, gateway, tx_id: t.id }),
    ]
    if (t.status === 'APPROVED') {
        events.push(
            make('tx', t.id, 'deposit_approved', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                gateway,
                hours_to_approve: null,
                is_first_deposit: null,
                tx_id: t.id,
            }),
        )
    } else if (t.status === 'REJECTED') {
        events.push(
            make('tx', t.id, 'deposit_rejected', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                hours_to_decision: null,
                has_note: null,
                tx_id: t.id,
            }),
        )
    }
    return events
}

export function withdrawalEvents(t: TxRow): BackfillEvent[] {
    const method = withdrawalMethodFromNote(t.note)
    const gateway = t.gateway ?? 'manual'
    const amount = Number(t.amount)
    const events = [
        make('tx', t.id, 'withdrawal_requested', t.userId, t.createdAt, { amount, method, gateway, tx_id: t.id }),
    ]
    if (t.status === 'APPROVED') {
        events.push(
            make('tx', t.id, 'withdrawal_approved', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                gateway,
                hours_to_decision: null,
                tx_id: t.id,
            }),
        )
    } else if (t.status === 'REJECTED') {
        events.push(
            make('tx', t.id, 'withdrawal_rejected', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                hours_to_decision: null,
                tx_id: t.id,
            }),
        )
    }
    return events
}

export function bonusEvent(t: TxRow): BackfillEvent | null {
    const source = BONUS_SOURCE_BY_TYPE[t.type]
    if (!source) return null
    const amount = Number(t.amount)
    if (!(amount > 0)) return null
    return make('tx', t.id, 'bonus_granted', t.userId, t.createdAt, {
        amount,
        source,
        rule_id: t.referenceId ?? null,
    })
}

export function gameJoinedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[] {
    const ticketPrice = Number(game.ticketPrice)
    return entrants.map((e) =>
        make('game', `${game.id}:${e.userId}`, 'game_joined', e.userId, e.firstJoinedAt, {
            game_id: game.id,
            template_id: game.templateId,
            ticket_price: ticketPrice,
            cartelas: e.cartelas,
            stake: Math.round(ticketPrice * e.cartelas * 100) / 100,
            spend_account: null,
        }),
    )
}

export function gameFinishedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[] {
    if (!game.endedAt) return []
    const endedAt = game.endedAt
    const ticketPrice = Number(game.ticketPrice)
    const totalEntries = entrants.reduce((s, e) => s + e.cartelas, 0)
    const prize = game.winnerId ? ticketPrice * totalEntries * (1 - Number(game.houseEdgePct) / 100) : 0
    const durationSecs = game.startedAt
        ? Math.max(0, Math.round((endedAt.getTime() - game.startedAt.getTime()) / 1000))
        : null
    return gameOutcomeEvents({
        gameId: game.id,
        templateId: game.templateId,
        ticketPrice,
        winnerId: game.winnerId,
        prize,
        durationSecs,
        entrants: entrants.map((e) => ({ userId: e.userId, cartelas: e.cartelas })),
    }).map((ev) => make('game', `${game.id}:${ev.userId}`, 'game_finished', ev.userId, endedAt, ev.properties))
}

export function gameRefundedEvents(game: GameRow, refunds: Array<{ userId: string; amount: number }>): BackfillEvent[] {
    const at = game.endedAt ?? game.createdAt
    return refunds.map((r) =>
        make('game', `${game.id}:${r.userId}`, 'game_refunded', r.userId, at, {
            game_id: game.id,
            template_id: game.templateId,
            reason: 'backfill',
            refund: r.amount,
        }),
    )
}

/**
 * Event names a primary-table mapper already owns. `wallet.controller.ts`
 * writes a `deposit_submitted` row into `analytics_events` for every manual
 * deposit, and `depositEvents()` derives the same event from `transactions`
 * — under a different uuid namespace, so PostHog cannot de-duplicate them.
 * The `transactions` row is the authoritative one (it carries amount, method,
 * gateway and tx_id), so the `analytics_events` copy is dropped.
 */
const OWNED_BY_PRIMARY_TABLE = new Set(['deposit_submitted'])

/**
 * `analytics_events.props` predates the snake_case convention. The live
 * `provider_game_launched` hook sends `provider_code` / `game_code`, so the
 * historical rows are renamed to match rather than splitting the property into
 * two spellings on one event.
 */
const PROP_RENAMES: Record<string, Record<string, string>> = {
    provider_game_launched: {
        providerCode: 'provider_code',
        gameCode: 'game_code',
        balanceBefore: 'balance_before',
    },
}

function renameProps(props: Record<string, unknown>, renames?: Record<string, string>): Record<string, unknown> {
    if (!renames) return props
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
        out[renames[key] ?? key] = value
    }
    return out
}

export function analyticsEventRow(e: AnalyticsRow): BackfillEvent | BackfillAlias | null {
    if (e.name === 'identify') {
        if (!e.userId || !e.anonId) return null
        return { distinctId: e.userId, alias: e.anonId }
    }
    if (OWNED_BY_PRIMARY_TABLE.has(e.name)) return null
    const distinctId = e.userId ?? e.anonId
    if (!distinctId) return null
    const props = e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {}
    return make('ae', e.id, e.name, distinctId, e.createdAt, renameProps(props, PROP_RENAMES[e.name]))
}
