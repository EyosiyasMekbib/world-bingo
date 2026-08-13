import { PredictionMarketStatus, Prisma } from '@prisma/client'
import { priceSchema, toWholeBirr } from '@world-bingo/shared-types'
import prisma from '../../lib/prisma.js'
import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { reportError } from '../../lib/sentry.js'
import { emitStatus } from '../../gateways/prediction.gateway.js'
import { PredictionSettlementService } from './settlement.service.js'

/**
 * Market lifecycle and admin CRUD for the binary order book.
 *
 *   DRAFT ──publish──► OPEN ──close/worker──► CLOSED ──resolve──► RESOLVING ──► SETTLED
 *                                              ▲                     │
 *                                              └──── unresolve ──────┘
 *   any non-terminal ──void──► VOIDED
 *
 * SETTLED and VOIDED are terminal: every transition out of them throws.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. **`shareValue` and `feePct` are snapshotted onto the market at creation**,
 *    read from `SiteSetting` once and then frozen. Nothing downstream reads a
 *    live setting or a hardcoded 100 — a payout must be computed from the terms
 *    that were true when the money was escrowed, not from whatever an admin
 *    typed into settings this morning.
 * 2. **Immutability after publish.** Once money can be escrowed against a market,
 *    the question, the fee, the share value and the outcome labels are frozen.
 *    Only presentation (`description`, `imageUrl`) and an EXTENDED `closesAt`
 *    stay editable. Renaming an outcome while orders rest against it is
 *    indistinguishable from rigging the market.
 * 3. **`disputeUntil` is stamped, not computed.** The window is read from
 *    `SiteSetting` at resolve time and written onto the row, so changing the
 *    setting afterwards can never move a payout that is already scheduled.
 *
 * Every state-changing admin action writes an `AuditLog` targeting
 * `prediction_market:<id>`, and every status change broadcasts `emitStatus`.
 */

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTING_SHARE_VALUE = 'prediction_share_value'
const SETTING_FEE_PCT = 'prediction_fee_pct'
const SETTING_DISPUTE_MINUTES = 'prediction_dispute_minutes'

/** Defaults when the setting row is missing or unusable. */
const FALLBACK_SHARE_VALUE = '100'
const FALLBACK_FEE_PCT = '15'
const FALLBACK_DISPUTE_MINUTES = '30'

const MINUTE_MS = 60_000

// ─── Queue ───────────────────────────────────────────────────────────────────

const JOB_SETTLE = 'settle-market'

/**
 * The settle job's id: derived from the market AND the resolution it belongs to.
 *
 * It has to be derivable — `unresolve`, `void` and the worker's boot recovery all
 * need to name a job they did not create — but it must NOT be reused across
 * resolutions. BullMQ's `add` is a no-op when the id already exists in ANY state,
 * including `completed`, and completed jobs linger under `removeOnComplete`. With
 * a bare `settle:<marketId>` a re-resolve after a first attempt had already run
 * would silently schedule nothing and strand the market in RESOLVING with its
 * winners unpaid — and the boot recovery would be dropped for the same reason.
 * Stamping `resolvedAt` gives every resolution its own id; the status guard in
 * `settleMarket` is what prevents a duplicate payout, not the shared id.
 */
export function predictionSettleJobId(marketId: string, resolvedAt: Date): string {
    return `settle:${marketId}:${resolvedAt.getTime()}`
}

// ─── Field limits (mirror `CreatePredictionMarketSchema` in shared-types) ─────

const MAX_EVENT_NAME = 120
const MAX_QUESTION = 240
const MAX_DESCRIPTION = 2000
const MAX_IMAGE_URL = 500

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

// ─── Public shapes ───────────────────────────────────────────────────────────

export type PredictionMarketWithOutcomes = Prisma.PredictionMarketGetPayload<{
    include: { outcomes: true }
}>

export interface PredictionOutcomeInput {
    label: string
    /** 0 or 1 — a binary market has exactly two sides. */
    sortOrder: number
}

export interface CreateMarketInput {
    eventName: string
    question: string
    description?: string | null
    imageUrl?: string | null
    closesAt: string | Date
    resolvesAt?: string | Date | null
    /**
     * Whole birr. Omitted → `SiteSetting.prediction_share_value`, else 100.
     * A number or its decimal string; never a float amount.
     */
    shareValue?: number | string
    /** Percent of PROFIT. Omitted → `SiteSetting.prediction_fee_pct`, else 15. */
    feePct?: number | string
    minOrderShares?: number
    maxOrderShares?: number
    outcomes: PredictionOutcomeInput[]
}

/**
 * Every field optional. Which of them are actually applied depends on status —
 * see rule 2 at the top of this file; the freeze is enforced in `updateMarket`
 * because only the server knows the current status.
 */
export interface UpdateMarketPatch {
    eventName?: string
    question?: string
    description?: string | null
    imageUrl?: string | null
    closesAt?: string | Date
    resolvesAt?: string | Date | null
    shareValue?: number | string
    feePct?: number | string
    minOrderShares?: number
    maxOrderShares?: number
    /** Labels only; `sortOrder` identifies which side is being renamed. */
    outcomes?: PredictionOutcomeInput[]
}

export interface MarketListFilter {
    status?: PredictionMarketStatus | PredictionMarketStatus[]
    eventName?: string
    /**
     * Hide DRAFT markets. The player-facing list passes true: an unpublished book
     * takes no orders and must not be advertised.
     */
    excludeDrafts?: boolean
    limit?: number
    cursor?: string
}

export interface MarketListResult {
    markets: PredictionMarketWithOutcomes[]
    nextCursor: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode })
}

/** Outcomes always come back in `sortOrder` order — side 0 then side 1. */
const OUTCOME_ORDER = { orderBy: { sortOrder: 'asc' } } as const

async function loadMarket(id: string): Promise<PredictionMarketWithOutcomes> {
    const market = await prisma.predictionMarket.findUnique({
        where: { id },
        include: { outcomes: OUTCOME_ORDER },
    })
    if (!market) throw httpError('Market not found', 404)
    return market
}

function assertNotTerminal(status: PredictionMarketStatus, verb: string): void {
    if (status === PredictionMarketStatus.SETTLED || status === PredictionMarketStatus.VOIDED) {
        throw httpError(`A ${status.toLowerCase()} market cannot be ${verb}`, 409)
    }
}

function requireText(value: unknown, field: string, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw httpError(`${field} is required`, 400)
    if (text.length > max) throw httpError(`${field} must be at most ${max} characters`, 400)
    return text
}

function optionalText(value: unknown, field: string, max: number): string | null {
    if (value === null || value === undefined) return null
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return null
    if (text.length > max) throw httpError(`${field} must be at most ${max} characters`, 400)
    return text
}

function toDate(value: string | Date, field: string): Date {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
    if (Number.isNaN(date.getTime())) throw httpError(`${field} is not a valid date`, 400)
    return date
}

function requireWholeShares(value: unknown, field: string): number {
    if (!Number.isInteger(value) || (value as number) < 1) {
        throw httpError(`${field} must be a whole number of at least 1 share`, 400)
    }
    return value as number
}

/**
 * Read a `SiteSetting`, falling back when the row is missing, blank, or holds a
 * value that would not survive validation. A fat-fingered setting must not be
 * able to create a market whose prices cannot be expressed.
 */
async function readSetting(
    key: string,
    fallback: string,
    isValid: (value: string) => boolean,
): Promise<string> {
    const row = await prisma.siteSetting.findUnique({ where: { key } }).catch(() => null)
    const value = row?.value?.trim()
    if (!value) return fallback
    if (!isValid(value)) {
        console.warn(
            `[PredictionMarket] SiteSetting ${key}="${value}" is unusable — falling back to ${fallback}`,
        )
        return fallback
    }
    return value
}

/**
 * Parse a share value: whole birr, and large enough to leave at least one legal
 * price. `priceSchema` is the same rule the order path enforces — building it
 * here proves at creation time that the market can price an order at all, rather
 * than discovering it when the first player tries to bid.
 */
function toShareValue(raw: number | string): Prisma.Decimal {
    let birr: number
    try {
        // Text parsing of the integer digits — `toWholeBirr` rejects any real
        // fraction rather than rounding one away. Not a float parse.
        birr = toWholeBirr(typeof raw === 'number' ? String(raw) : raw)
    } catch {
        throw httpError('Share value must be a whole number of birr', 400)
    }
    try {
        priceSchema(birr)
    } catch (err) {
        throw httpError((err as Error).message, 400)
    }
    return new Prisma.Decimal(birr)
}

/**
 * Parse a fee percentage: 0..100 with at most two decimal places.
 *
 * The bounds are inspected as TEXT and the Decimal is built from the string, so
 * no money value is ever routed through a JS float.
 */
function toFeePct(raw: number | string): Prisma.Decimal {
    const text = (typeof raw === 'number' ? String(raw) : raw).trim()
    if (!/^\d+(\.\d+)?$/.test(text)) {
        throw httpError('Fee percent must be a positive decimal number', 400)
    }
    const fraction = text.split('.')[1]
    if (fraction && fraction.length > 2) {
        throw httpError('Fee percent supports at most two decimal places', 400)
    }
    const fee = new Prisma.Decimal(text)
    if (fee.greaterThan(100)) throw httpError('Fee percent must be between 0 and 100', 400)
    return fee
}

function isValidShareValue(value: string): boolean {
    try {
        priceSchema(toWholeBirr(value))
        return true
    } catch {
        return false
    }
}

function isValidFeePct(value: string): boolean {
    try {
        toFeePct(value)
        return true
    } catch {
        return false
    }
}

/** Whole, non-negative minutes. A count, not money — integer parsing is correct here. */
function isValidMinutes(value: string): boolean {
    return /^\d+$/.test(value)
}

/**
 * Exactly two outcomes carrying `sortOrder` 0 and 1, with distinct non-empty
 * labels. A third side, a missing side, or two sides claiming the same slot all
 * break the complementary-price identity the whole book rests on: buying A at
 * `p` is only the counterparty to buying B at `shareValue - p` when there are
 * precisely two sides.
 */
function normalizeOutcomes(outcomes: PredictionOutcomeInput[] | undefined): PredictionOutcomeInput[] {
    if (!Array.isArray(outcomes) || outcomes.length !== 2) {
        throw httpError('A binary market needs exactly 2 outcomes', 400)
    }

    const normalized = outcomes.map((outcome) => ({
        label: requireText(outcome?.label, 'Outcome label', 64),
        sortOrder: outcome?.sortOrder,
    }))

    for (const outcome of normalized) {
        if (outcome.sortOrder !== 0 && outcome.sortOrder !== 1) {
            throw httpError('Outcome sortOrder must be 0 and 1', 400)
        }
    }
    if (normalized[0].sortOrder === normalized[1].sortOrder) {
        throw httpError('Outcome sortOrder must be 0 and 1', 400)
    }
    if (normalized[0].label.toLowerCase() === normalized[1].label.toLowerCase()) {
        throw httpError('The two outcomes must have different labels', 400)
    }

    return [...normalized].sort((a, b) => a.sortOrder - b.sortOrder) as PredictionOutcomeInput[]
}

/** The JWT carries no username, so the audit trail resolves it here. */
async function actorName(adminId?: string | null): Promise<string | null> {
    if (!adminId) return null
    const user = await prisma.user
        .findUnique({ where: { id: adminId }, select: { username: true } })
        .catch(() => null)
    return user?.username ?? null
}

/**
 * Append-only trace of privileged actions. A failed audit write is logged but
 * never thrown — auditing must not block the action it records, and the money
 * paths have their own guards.
 */
async function writeAudit(
    action: string,
    marketId: string,
    adminId: string | null | undefined,
    detail: Record<string, unknown>,
): Promise<void> {
    await prisma.auditLog
        .create({
            data: {
                action,
                actorId: adminId ?? null,
                actorName: await actorName(adminId),
                target: `prediction_market:${marketId}`,
                detail: detail as Prisma.InputJsonObject,
            },
        })
        .catch((err: unknown) => {
            console.error(`[PredictionMarket] Audit write failed for ${action} on ${marketId}:`, err)
        })
}

/**
 * Schedule the payout for the end of the dispute window.
 *
 * A failure here leaves the market RESOLVING with nothing queued, which the
 * worker repairs on boot by re-enqueueing every RESOLVING market. So this is
 * loud but not fatal: failing the admin's resolve would leave the market CLOSED
 * and require the whole action again, which is strictly worse than a payout that
 * is recovered a restart later.
 */
async function scheduleSettlement(
    marketId: string,
    resolvedAt: Date,
    delayMs: number,
): Promise<void> {
    const delay = Math.max(0, Math.round(delayMs))
    try {
        await getQueue(QUEUE_NAMES.PREDICTION).add(
            JOB_SETTLE,
            { marketId },
            {
                jobId: predictionSettleJobId(marketId, resolvedAt),
                delay,
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 50 },
            },
        )
    } catch (err) {
        console.error(`[PredictionMarket] Failed to schedule settlement for ${marketId}:`, err)
        reportError(err, { service: 'prediction-market', action: 'schedule-settlement', marketId })
    }
}

/**
 * Pull a pending payout back out of the queue.
 *
 * Best-effort by design. The market row is flipped out of RESOLVING *before*
 * this runs, and the flip happens under the settle lock, so a job that survives
 * removal either cannot start (the lock is held) or starts and finds a status it
 * refuses to pay. Removing it keeps the queue honest; it is not what makes the
 * unresolve safe. Because every resolution gets its own job id, a job that
 * outlives its removal can also never block the NEXT resolution's job.
 */
async function cancelScheduledSettlement(
    marketId: string,
    resolvedAt: Date | null,
): Promise<boolean> {
    if (!resolvedAt) return false
    try {
        const job = await getQueue(QUEUE_NAMES.PREDICTION).getJob(
            predictionSettleJobId(marketId, resolvedAt),
        )
        if (!job) return false
        await job.remove()
        return true
    } catch (err) {
        console.error(`[PredictionMarket] Failed to remove settle job for ${marketId}:`, err)
        reportError(err, { service: 'prediction-market', action: 'cancel-settlement', marketId })
        return false
    }
}

function clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE
    return Math.min(Math.floor(limit), MAX_PAGE_SIZE)
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class PredictionMarketService {
    // ── Reads ───────────────────────────────────────────────────────────────

    /**
     * Markets with both outcomes (and their last traded price), soonest to close
     * first — which on a fight card is bout order. Cursor paginated.
     */
    static async listMarkets(filter: MarketListFilter = {}): Promise<MarketListResult> {
        const limit = clampLimit(filter.limit)
        const where: Prisma.PredictionMarketWhereInput = {}

        if (filter.status) {
            where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status
        } else if (filter.excludeDrafts) {
            where.status = { not: PredictionMarketStatus.DRAFT }
        }

        if (filter.eventName) {
            where.eventName = { equals: filter.eventName, mode: 'insensitive' }
        }

        const rows = await prisma.predictionMarket.findMany({
            where,
            include: { outcomes: OUTCOME_ORDER },
            // `id` breaks ties so the page boundary is stable when a whole card
            // shares one `closesAt`.
            orderBy: [{ closesAt: 'asc' }, { id: 'asc' }],
            take: limit + 1,
            ...(filter.cursor ? { skip: 1, cursor: { id: filter.cursor } } : {}),
        })

        const hasMore = rows.length > limit
        const markets = hasMore ? rows.slice(0, limit) : rows

        return {
            markets,
            nextCursor: hasMore ? markets[markets.length - 1].id : null,
        }
    }

    /** One market with both outcomes in `sortOrder` order, each carrying `lastPrice`. */
    static async getMarket(id: string): Promise<PredictionMarketWithOutcomes> {
        return loadMarket(id)
    }

    // ── Create ──────────────────────────────────────────────────────────────

    /**
     * Create a market as a DRAFT. Publishing is a separate, deliberate action so
     * the operator can open the main event first and release the undercard as
     * interest appears.
     *
     * `shareValue` and `feePct` are resolved here — from the input if the admin
     * overrode them, otherwise from `SiteSetting` — and written onto the row.
     * That snapshot is the market's terms for the rest of its life.
     */
    static async createMarket(
        input: CreateMarketInput,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const outcomes = normalizeOutcomes(input.outcomes)
        const eventName = requireText(input.eventName, 'Event name', MAX_EVENT_NAME)
        const question = requireText(input.question, 'Question', MAX_QUESTION)
        const description = optionalText(input.description, 'Description', MAX_DESCRIPTION)
        const imageUrl = optionalText(input.imageUrl, 'Image URL', MAX_IMAGE_URL)

        const closesAt = toDate(input.closesAt, 'closesAt')
        if (closesAt.getTime() <= Date.now()) {
            throw httpError('closesAt must be in the future', 400)
        }
        const resolvesAt = input.resolvesAt ? toDate(input.resolvesAt, 'resolvesAt') : null

        const shareValue =
            input.shareValue === undefined || input.shareValue === null || input.shareValue === ''
                ? toShareValue(
                      await readSetting(SETTING_SHARE_VALUE, FALLBACK_SHARE_VALUE, isValidShareValue),
                  )
                : toShareValue(input.shareValue)

        const feePct =
            input.feePct === undefined || input.feePct === null || input.feePct === ''
                ? toFeePct(await readSetting(SETTING_FEE_PCT, FALLBACK_FEE_PCT, isValidFeePct))
                : toFeePct(input.feePct)

        const minOrderShares =
            input.minOrderShares === undefined
                ? undefined
                : requireWholeShares(input.minOrderShares, 'Minimum order size')
        const maxOrderShares =
            input.maxOrderShares === undefined
                ? undefined
                : requireWholeShares(input.maxOrderShares, 'Maximum order size')
        if (
            minOrderShares !== undefined &&
            maxOrderShares !== undefined &&
            minOrderShares > maxOrderShares
        ) {
            throw httpError('Maximum order size must not be below the minimum', 400)
        }

        // One transaction: Prisma commits a nested create with its parent, so a
        // market can never exist with one outcome, or with none.
        const market = await prisma.predictionMarket.create({
            data: {
                eventName,
                question,
                description,
                imageUrl,
                status: PredictionMarketStatus.DRAFT,
                closesAt,
                resolvesAt,
                shareValue,
                feePct,
                ...(minOrderShares !== undefined ? { minOrderShares } : {}),
                ...(maxOrderShares !== undefined ? { maxOrderShares } : {}),
                createdById: adminId ?? null,
                outcomes: {
                    create: outcomes.map((outcome) => ({
                        label: outcome.label,
                        sortOrder: outcome.sortOrder,
                    })),
                },
            },
            include: { outcomes: OUTCOME_ORDER },
        })

        await writeAudit('prediction.create', market.id, adminId, {
            eventName,
            question,
            closesAt: closesAt.toISOString(),
            shareValue: shareValue.toString(),
            feePct: feePct.toString(),
            outcomes: outcomes.map((outcome) => outcome.label),
        })

        // No emitStatus: a DRAFT has no room, no book and no subscribers yet.
        return market
    }

    // ── Update ──────────────────────────────────────────────────────────────

    /**
     * Edit a market, subject to the freeze.
     *
     * While DRAFT everything is editable. From OPEN onwards only `description`,
     * `imageUrl` and a LATER `closesAt` are — anything else that would actually
     * change value is rejected 409.
     *
     * The check is on the VALUE, not on the field being present: an admin form
     * that posts the whole market back must be able to edit the description
     * without having to strip the unchanged frozen fields out of the body first.
     * Re-sending `question` unchanged is not an edit.
     */
    static async updateMarket(
        id: string,
        patch: UpdateMarketPatch,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const market = await loadMarket(id)
        assertNotTerminal(market.status, 'edited')

        const isDraft = market.status === PredictionMarketStatus.DRAFT
        const data: Prisma.PredictionMarketUpdateInput = {}
        const changed: string[] = []
        const frozen: string[] = []

        const freeze = (field: string) => {
            if (!frozen.includes(field)) frozen.push(field)
        }

        if (patch.eventName !== undefined) {
            const eventName = requireText(patch.eventName, 'Event name', MAX_EVENT_NAME)
            if (eventName !== market.eventName) {
                if (!isDraft) freeze('eventName')
                else {
                    data.eventName = eventName
                    changed.push('eventName')
                }
            }
        }

        if (patch.question !== undefined) {
            const question = requireText(patch.question, 'Question', MAX_QUESTION)
            if (question !== market.question) {
                if (!isDraft) freeze('question')
                else {
                    data.question = question
                    changed.push('question')
                }
            }
        }

        // Presentation, not terms. Changing the blurb or the poster cannot alter
        // what a resting order is a bet on, so these stay editable throughout.
        if (patch.description !== undefined) {
            const description = optionalText(patch.description, 'Description', MAX_DESCRIPTION)
            if (description !== market.description) {
                data.description = description
                changed.push('description')
            }
        }

        if (patch.imageUrl !== undefined) {
            const imageUrl = optionalText(patch.imageUrl, 'Image URL', MAX_IMAGE_URL)
            if (imageUrl !== market.imageUrl) {
                data.imageUrl = imageUrl
                changed.push('imageUrl')
            }
        }

        if (patch.closesAt !== undefined) {
            const closesAt = toDate(patch.closesAt, 'closesAt')
            if (closesAt.getTime() !== market.closesAt.getTime()) {
                if (isDraft) {
                    if (closesAt.getTime() <= Date.now()) {
                        throw httpError('closesAt must be in the future', 400)
                    }
                } else if (closesAt.getTime() < market.closesAt.getTime()) {
                    // Extending gives players more time to trade. Pulling it in
                    // strands orders that were placed expecting a longer book.
                    throw httpError('closesAt can only be extended once a market is published', 409)
                }
                data.closesAt = closesAt
                changed.push('closesAt')
            }
        }

        if (patch.resolvesAt !== undefined) {
            const resolvesAt = patch.resolvesAt ? toDate(patch.resolvesAt, 'resolvesAt') : null
            const current = market.resolvesAt ? market.resolvesAt.getTime() : null
            if ((resolvesAt ? resolvesAt.getTime() : null) !== current) {
                if (!isDraft) freeze('resolvesAt')
                else {
                    data.resolvesAt = resolvesAt
                    changed.push('resolvesAt')
                }
            }
        }

        if (patch.shareValue !== undefined) {
            const shareValue = toShareValue(patch.shareValue)
            if (!shareValue.equals(market.shareValue)) {
                if (!isDraft) freeze('shareValue')
                else {
                    data.shareValue = shareValue
                    changed.push('shareValue')
                }
            }
        }

        if (patch.feePct !== undefined) {
            const feePct = toFeePct(patch.feePct)
            if (!feePct.equals(market.feePct)) {
                if (!isDraft) freeze('feePct')
                else {
                    data.feePct = feePct
                    changed.push('feePct')
                }
            }
        }

        let minOrderShares = market.minOrderShares
        let maxOrderShares = market.maxOrderShares

        if (patch.minOrderShares !== undefined) {
            const value = requireWholeShares(patch.minOrderShares, 'Minimum order size')
            if (value !== market.minOrderShares) {
                if (!isDraft) freeze('minOrderShares')
                else {
                    minOrderShares = value
                    data.minOrderShares = value
                    changed.push('minOrderShares')
                }
            }
        }

        if (patch.maxOrderShares !== undefined) {
            const value = requireWholeShares(patch.maxOrderShares, 'Maximum order size')
            if (value !== market.maxOrderShares) {
                if (!isDraft) freeze('maxOrderShares')
                else {
                    maxOrderShares = value
                    data.maxOrderShares = value
                    changed.push('maxOrderShares')
                }
            }
        }

        if (minOrderShares > maxOrderShares) {
            throw httpError('Maximum order size must not be below the minimum', 400)
        }

        const outcomeUpdates: Array<{ id: string; label: string }> = []
        if (patch.outcomes !== undefined) {
            for (const incoming of normalizeOutcomes(patch.outcomes)) {
                const current = market.outcomes.find(
                    (outcome) => outcome.sortOrder === incoming.sortOrder,
                )
                if (!current) throw httpError('That outcome does not belong to this market', 400)
                if (current.label === incoming.label) continue
                if (!isDraft) freeze('outcome labels')
                else outcomeUpdates.push({ id: current.id, label: incoming.label })
            }
        }

        if (frozen.length > 0) {
            throw httpError(
                `Cannot change ${frozen.join(', ')} once a market is published`,
                409,
            )
        }

        // Nothing actually differs — return the market rather than writing an
        // empty update and an audit entry recording that nothing happened.
        if (changed.length === 0 && outcomeUpdates.length === 0) return market

        const updated = await prisma.$transaction(async (tx) => {
            for (const outcome of outcomeUpdates) {
                await tx.predictionOutcome.update({
                    where: { id: outcome.id },
                    data: { label: outcome.label },
                })
            }
            if (changed.length > 0) {
                await tx.predictionMarket.update({ where: { id }, data })
            }
            return tx.predictionMarket.findUnique({
                where: { id },
                include: { outcomes: OUTCOME_ORDER },
            })
        })

        await writeAudit('prediction.update', id, adminId, {
            status: market.status,
            changed: outcomeUpdates.length > 0 ? [...changed, 'outcomes'] : changed,
        })

        // No status change, so no `emitStatus` — the book is unaffected.
        return updated as PredictionMarketWithOutcomes
    }

    // ── Publish ─────────────────────────────────────────────────────────────

    /**
     * DRAFT → OPEN. Re-validates the shape rather than trusting what creation
     * checked: a market can sit in DRAFT for weeks, and `closesAt` may well have
     * passed in the meantime.
     */
    static async publishMarket(
        id: string,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const market = await loadMarket(id)

        if (market.status !== PredictionMarketStatus.DRAFT) {
            throw httpError(
                market.status === PredictionMarketStatus.OPEN
                    ? 'This market is already published'
                    : 'Only a draft market can be published',
                409,
            )
        }

        const sortOrders = market.outcomes.map((outcome) => outcome.sortOrder)
        if (
            market.outcomes.length !== 2 ||
            !sortOrders.includes(0) ||
            !sortOrders.includes(1)
        ) {
            throw httpError('A binary market needs exactly 2 outcomes', 409)
        }
        if (market.closesAt.getTime() <= Date.now()) {
            throw httpError('closesAt is in the past — extend it before publishing', 409)
        }

        // Guarded on the status we read, so two admins clicking publish at once
        // produce one transition and one 409.
        const claimed = await prisma.predictionMarket.updateMany({
            where: { id, status: PredictionMarketStatus.DRAFT },
            data: { status: PredictionMarketStatus.OPEN },
        })
        if (claimed.count === 0) throw httpError('This market is no longer a draft', 409)

        await writeAudit('prediction.publish', id, adminId, {
            question: market.question,
            closesAt: market.closesAt.toISOString(),
        })
        await emitStatus(id)

        return loadMarket(id)
    }

    // ── Close ───────────────────────────────────────────────────────────────

    /**
     * OPEN → CLOSED. Idempotent: an already-CLOSED market is a no-op, not an
     * error, because the worker's 30s tick and an admin closing early race by
     * design and neither should see a failure.
     */
    static async closeMarket(
        id: string,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const market = await loadMarket(id)

        if (market.status === PredictionMarketStatus.CLOSED) return market
        if (market.status !== PredictionMarketStatus.OPEN) {
            throw httpError('Only an open market can be closed', 409)
        }

        const claimed = await prisma.predictionMarket.updateMany({
            where: { id, status: PredictionMarketStatus.OPEN },
            data: { status: PredictionMarketStatus.CLOSED },
        })

        if (claimed.count === 0) {
            // Lost the race. If the winner also closed it, that is the outcome
            // this call wanted — still a no-op.
            const fresh = await loadMarket(id)
            if (fresh.status === PredictionMarketStatus.CLOSED) return fresh
            throw httpError('This market is no longer open', 409)
        }

        await writeAudit('prediction.close', id, adminId, {
            question: market.question,
            closesAt: market.closesAt.toISOString(),
            early: Date.now() < market.closesAt.getTime(),
        })
        await emitStatus(id)

        return loadMarket(id)
    }

    /**
     * Bulk OPEN → CLOSED for everything past its `closesAt`. Driven by the
     * worker's repeatable tick; returns the ids it actually closed.
     *
     * Each market is claimed with its own status-guarded update rather than one
     * blanket `updateMany`, so a second worker instance running the same tick
     * cannot make both of them report the same market as theirs — and so a
     * status broadcast fires exactly once per real transition.
     */
    static async closeDueMarkets(): Promise<string[]> {
        const due = await prisma.predictionMarket.findMany({
            where: { status: PredictionMarketStatus.OPEN, closesAt: { lte: new Date() } },
            select: { id: true },
            orderBy: { closesAt: 'asc' },
        })
        if (due.length === 0) return []

        const closed: string[] = []

        for (const market of due) {
            const claimed = await prisma.predictionMarket.updateMany({
                where: { id: market.id, status: PredictionMarketStatus.OPEN },
                data: { status: PredictionMarketStatus.CLOSED },
            })
            if (claimed.count === 0) continue

            closed.push(market.id)
            await emitStatus(market.id)
        }

        if (closed.length > 0) {
            console.log(`[PredictionMarket] Closed ${closed.length} market(s) past closesAt`)
        }

        return closed
    }

    // ── Resolve ─────────────────────────────────────────────────────────────

    /**
     * CLOSED → RESOLVING. Names the winning side and schedules the payout for the
     * end of the dispute window.
     *
     * ETFC is a third-party event with no result feed, so a human calls it. The
     * window between the call and the money moving is the whole mitigation for a
     * miscall: `unresolve` can take it back until `disputeUntil`, after which the
     * delayed job pays out.
     */
    static async resolveMarket(
        id: string,
        outcomeId: string,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const market = await loadMarket(id)

        if (market.status !== PredictionMarketStatus.CLOSED) {
            throw httpError('Only a closed market can be resolved', 409)
        }

        const winner = market.outcomes.find((outcome) => outcome.id === outcomeId)
        if (!winner) throw httpError('That outcome does not belong to this market', 400)

        // Stamped, not computed: `disputeUntil` is written onto the row so that
        // editing the setting afterwards cannot move a payout already scheduled.
        const minutes = Number.parseInt(
            await readSetting(SETTING_DISPUTE_MINUTES, FALLBACK_DISPUTE_MINUTES, isValidMinutes),
            10,
        )
        const resolvedAt = new Date()
        const disputeUntil = new Date(resolvedAt.getTime() + minutes * MINUTE_MS)

        const claimed = await prisma.predictionMarket.updateMany({
            where: { id, status: PredictionMarketStatus.CLOSED },
            data: {
                status: PredictionMarketStatus.RESOLVING,
                winningOutcomeId: outcomeId,
                resolvedById: adminId ?? null,
                resolvedAt,
                disputeUntil,
            },
        })
        if (claimed.count === 0) throw httpError('This market is no longer closed', 409)

        await scheduleSettlement(id, resolvedAt, disputeUntil.getTime() - Date.now())

        await writeAudit('prediction.resolve', id, adminId, {
            question: market.question,
            winningOutcomeId: outcomeId,
            winningLabel: winner.label,
            resolvedAt: resolvedAt.toISOString(),
            disputeUntil: disputeUntil.toISOString(),
            disputeMinutes: minutes,
        })
        await emitStatus(id)

        return loadMarket(id)
    }

    /**
     * RESOLVING → CLOSED, only from inside the dispute window.
     *
     * The whole reversal runs under `lock:prediction:settle:<id>` — the lock the
     * payout itself takes — because the two are millisecond neighbours at the
     * edge of the window and settlement reads the market once and then pays for
     * as long as it takes. Without the lock an unresolve could land after that
     * read and leave the market reading CLOSED with every winner already paid,
     * ready for an admin to "correct" the call and pay the other side too.
     *
     * Holding it means one of the two definitely wins: either the payout is
     * already running and this returns 409, or this reverses first and the settle
     * job finds a status it refuses to pay. The status flip still comes before
     * the job removal — removing the job is housekeeping, not the safety net.
     */
    static async unresolveMarket(
        id: string,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const attempt = await PredictionSettlementService.withSettleLock(id, async () => {
            // Re-read INSIDE the lock. Both the status and the window may have
            // moved while we were queueing for it.
            const market = await loadMarket(id)

            if (market.status !== PredictionMarketStatus.RESOLVING) {
                throw httpError('Only a market awaiting settlement can be unresolved', 409)
            }
            if (!market.disputeUntil || Date.now() >= market.disputeUntil.getTime()) {
                // Past the window the payout is either running or done, and reversing
                // it would mean clawing money back out of players' wallets.
                throw httpError('The dispute window has closed — resolve it correctly instead', 409)
            }

            const claimed = await prisma.predictionMarket.updateMany({
                where: { id, status: PredictionMarketStatus.RESOLVING },
                data: {
                    status: PredictionMarketStatus.CLOSED,
                    winningOutcomeId: null,
                    resolvedById: null,
                    resolvedAt: null,
                    disputeUntil: null,
                },
            })
            if (claimed.count === 0) {
                throw httpError('This market is no longer awaiting settlement', 409)
            }

            const jobRemoved = await cancelScheduledSettlement(id, market.resolvedAt)
            return { market, jobRemoved }
        })

        if (!attempt.acquired) {
            throw httpError('This market is being settled right now — it can no longer be reversed', 409)
        }

        const { market, jobRemoved } = attempt.result!

        await writeAudit('prediction.unresolve', id, adminId, {
            question: market.question,
            previousWinningOutcomeId: market.winningOutcomeId,
            previousWinningLabel:
                market.outcomes.find((outcome) => outcome.id === market.winningOutcomeId)?.label ?? null,
            disputeUntil: market.disputeUntil!.toISOString(),
            settleJobRemoved: jobRemoved,
        })
        await emitStatus(id)

        return loadMarket(id)
    }

    // ── Void ────────────────────────────────────────────────────────────────

    /**
     * Any non-terminal status → VOIDED: a draw, a no-contest, a cancelled bout,
     * or an admin unwinding a market that should never have opened.
     *
     * The refunds themselves belong to the settlement service — it owns the
     * per-market lock, the batching and the idempotency guards, and it also
     * emits the status broadcast once the money is back. This method is the
     * lifecycle gate and the audit trail in front of it.
     */
    static async voidMarket(
        id: string,
        reason: string,
        adminId?: string | null,
    ): Promise<PredictionMarketWithOutcomes> {
        const market = await loadMarket(id)
        assertNotTerminal(market.status, 'voided')

        const voidReason = requireText(reason, 'Void reason', 500)

        // Drop any pending payout before refunding. Settlement would refuse to
        // pay a VOIDED market anyway, but leaving a live job pointing at it is
        // noise the on-call does not need.
        if (market.status === PredictionMarketStatus.RESOLVING) {
            await cancelScheduledSettlement(id, market.resolvedAt)
        }

        const result = await PredictionSettlementService.voidMarket(id, voidReason)

        if (!result.voided) {
            if (result.reason === 'market_not_found') throw httpError('Market not found', 404)
            if (result.reason === 'market_already_settled') {
                throw httpError('A settled market cannot be voided', 409)
            }
            // lock_not_acquired — a settle or an earlier void is mid-flight.
            throw httpError('This market is already being settled — try again shortly', 409)
        }

        await writeAudit('prediction.void', id, adminId, {
            question: market.question,
            reason: voidReason,
            previousStatus: market.status,
            positionsRefunded: result.positionsRefunded,
            ordersRefunded: result.ordersRefunded,
            totalRefunded: result.totalRefunded.toString(),
        })

        // `emitStatus` is not called here: PredictionSettlementService.voidMarket
        // broadcasts it the moment it claims the VOIDED transition, which is the
        // point at which the status becomes true — and, because that claim now
        // happens before the refunds rather than after them, the point at which
        // clients need to stop showing the market as tradeable.
        return loadMarket(id)
    }
}

export default PredictionMarketService
