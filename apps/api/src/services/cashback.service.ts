import prisma from '../lib/prisma'
import { Prisma } from '@prisma/client'
import {
    TransactionType,
    PaymentStatus,
    NotificationType,
    CashbackRefundType,
    CashbackFrequency,
    CashbackPayoutTiming,
} from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { dayBucketStart, weekBucketStart, monthBucketStart, monthBucketEnd } from '../lib/bonus-period'

const DAY_MS = 24 * 60 * 60 * 1000
import { NotificationService } from './notification.service'
import { BonusService } from './bonus.service'
import { captureEvent } from '../lib/posthog'

/** The payout-shaping columns every amount calculation in here reads. */
type PayoutConfig = {
    refundType: CashbackRefundType | string
    refundValue: Decimal | number
    maxPayoutPerPlayer: Decimal | null
}

export interface CashbackSettlement {
    promotionId: string
    name: string
    payoutTiming: CashbackPayoutTiming
    periodStart: Date
    periodEnd: Date
    disbursed: number
    skipped: number
    budgetSkipped: number
    total: Decimal
}

export interface CashbackRunResult {
    promotionsChecked: number
    totalDisbursed: number
    totalAmount: Decimal
    settlements: CashbackSettlement[]
}

export interface CashbackDisburseResult {
    disbursed: number
    skipped: number
    budgetSkipped: number
    total: Decimal
}

export interface CashbackPreview {
    periodStart: Date
    periodEnd: Date
    players: number
    projectedTotal: Decimal
    largest: Decimal
    top: Array<{ username: string; netLoss: Decimal; payout: Decimal }>
}

/**
 * The start and end of the current frequency window, cut on
 * Africa/Addis_Ababa and returned as UTC instants.
 *
 * Addis, not UTC, because "lost this week" is a claim about the player's week.
 * Cutting in UTC made a Monday-to-Sunday promotion settle at 02:59 on Monday
 * local, put the last three hours of every local day in the next window, and
 * left this the only bonus surface disagreeing with `lib/bonus-period`, which
 * has always bucketed deposit bonuses on Addis. Two different weeks on one
 * wallet is not a thing that can be explained to a player.
 *
 * Ethiopia observes no DST, so the offset is a fixed +3 and every local day is
 * exactly 24 hours — which is what lets the ends below be derived by adding a
 * duration rather than by re-deriving local calendar arithmetic.
 */
export function getCurrentPeriod(frequency: CashbackFrequency, now = new Date()): { periodStart: Date; periodEnd: Date } {
    if (frequency === CashbackFrequency.DAILY) {
        const periodStart = dayBucketStart(now)
        return { periodStart, periodEnd: new Date(periodStart.getTime() + DAY_MS - 1) }
    }

    if (frequency === CashbackFrequency.WEEKLY) {
        const periodStart = weekBucketStart(now)
        return { periodStart, periodEnd: new Date(periodStart.getTime() + 7 * DAY_MS - 1) }
    }

    return { periodStart: monthBucketStart(now), periodEnd: monthBucketEnd(now) }
}

/**
 * The window that closed most recently — what a PERIOD_CLOSE promotion settles.
 * Derived by asking getCurrentPeriod about the instant one millisecond before
 * the open window began, so ISO-week and month-length arithmetic stays in one
 * place instead of being re-derived (and re-broken) here.
 */
export function getPreviousPeriod(frequency: CashbackFrequency, now = new Date()): { periodStart: Date; periodEnd: Date } {
    const { periodStart } = getCurrentPeriod(frequency, now)
    return getCurrentPeriod(frequency, new Date(periodStart.getTime() - 1))
}

export class CashbackService {
    /**
     * Create a new cashback promotion.
     */
    static async createPromotion(data: {
        name: string
        lossThreshold: number
        refundType: CashbackRefundType
        refundValue: number
        frequency: CashbackFrequency
        startsAt: string
        endsAt: string
        templateIds?: string[]
        providerGameKeys?: string[]
        maxPayoutPerPlayer?: number | null
        periodBudget?: number | null
        payoutTiming?: CashbackPayoutTiming
        bonusValidityHours?: number
        isActive?: boolean
    }) {
        return prisma.cashbackPromotion.create({
            data: {
                name: data.name,
                lossThreshold: data.lossThreshold,
                refundType: data.refundType,
                refundValue: data.refundValue,
                frequency: data.frequency,
                startsAt: new Date(data.startsAt),
                endsAt: new Date(data.endsAt),
                templateIds: data.templateIds ?? [],
                providerGameKeys: data.providerGameKeys ?? [],
                // null on the two cap columns IS the meaning "uncapped", so an
                // omitted field maps straight to it. payoutTiming and
                // bonusValidityHours instead have schema defaults worth
                // deferring to, hence the spreads rather than a `?? null`.
                maxPayoutPerPlayer: data.maxPayoutPerPlayer ?? null,
                periodBudget: data.periodBudget ?? null,
                ...(data.payoutTiming ? { payoutTiming: data.payoutTiming } : {}),
                ...(data.bonusValidityHours != null ? { bonusValidityHours: data.bonusValidityHours } : {}),
                // Same reason as the two above: the column defaults to true, and
                // an omitted field should mean "as the schema says", not false.
                ...(data.isActive != null ? { isActive: data.isActive } : {}),
            },
        })
    }

    /**
     * List all promotions, newest first. Resolves each promotion's game
     * scope into display names so the admin UI needs no second round-trip.
     */
    static async listPromotions() {
        const promotions = await prisma.cashbackPromotion.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { disbursements: true } } },
        })

        const allTemplateIds = [...new Set(promotions.flatMap((p) => p.templateIds))]
        const allProviderGameKeys = [...new Set(promotions.flatMap((p) => p.providerGameKeys))]

        const templates = allTemplateIds.length > 0
            ? await prisma.gameTemplate.findMany({ where: { id: { in: allTemplateIds } }, select: { id: true, title: true } })
            : []
        const templateTitleById = new Map(templates.map((t) => [t.id, t.title]))

        const providerPairs = allProviderGameKeys
            .map((key) => {
                const separatorIndex = key.indexOf(':')
                if (separatorIndex === -1) return null
                return { key, providerId: key.slice(0, separatorIndex), gameCode: key.slice(separatorIndex + 1) }
            })
            .filter((p): p is { key: string; providerId: string; gameCode: string } => p !== null)

        const providerGames = providerPairs.length > 0
            ? await prisma.providerGame.findMany({
                  where: { OR: providerPairs.map((p) => ({ providerId: p.providerId, gameCode: p.gameCode })) },
                  select: { providerId: true, gameCode: true, gameName: true },
              })
            : []
        const providerGameNameByKey = new Map(providerGames.map((g) => [`${g.providerId}:${g.gameCode}`, g.gameName]))

        return promotions.map((promotion) => ({
            ...promotion,
            scopedGameNames: [
                ...promotion.templateIds.map((id) => templateTitleById.get(id) ?? 'Unknown template'),
                ...promotion.providerGameKeys.map((key) => providerGameNameByKey.get(key) ?? 'Unknown game'),
            ],
        }))
    }

    /**
     * Toggle a promotion's isActive flag.
     */
    static async togglePromotion(id: string, isActive: boolean) {
        return prisma.cashbackPromotion.update({
            where: { id },
            data: { isActive },
        })
    }

    /**
     * Check all active promotions and disburse cashback to qualifying players.
     * Called hourly by the cashback-checker worker.
     */
    static async runChecks(): Promise<CashbackRunResult> {
        const now = new Date()

        // A PERIOD_CLOSE promotion settles a window only once that window has
        // ENDED, so its final settlement falls due after its own endsAt — an
        // `endsAt >= now` filter here would silently swallow the last period a
        // promotion ever ran. Widen the fetch to anything still live inside the
        // longest closed window (a month) and let the per-promotion check below
        // decide; ON_THRESHOLD keeps paying only while the promotion is live.
        const earliestClosedPeriodStart = getPreviousPeriod(CashbackFrequency.MONTHLY, now).periodStart

        const activePromotions = await prisma.cashbackPromotion.findMany({
            where: {
                isActive: true,
                startsAt: { lte: now },
                endsAt: { gte: earliestClosedPeriodStart },
            },
        })

        let totalDisbursed = 0
        let totalAmount = new Decimal(0)
        const settlements: CashbackSettlement[] = []

        for (const promotion of activePromotions) {
            const frequency = promotion.frequency as CashbackFrequency
            const payoutTiming = promotion.payoutTiming as CashbackPayoutTiming

            const onThreshold = payoutTiming === CashbackPayoutTiming.ON_THRESHOLD

            // PERIOD_CLOSE settles the window that has already ENDED: paying into
            // the open one hands a player cashback on a loss they might still win
            // back before the period is out. ON_THRESHOLD is the older behaviour
            // and deliberately pays into the live window.
            const { periodStart, periodEnd } = onThreshold
                ? getCurrentPeriod(frequency, now)
                : getPreviousPeriod(frequency, now)

            if (onThreshold) {
                // Nothing left to top up once the promotion itself is over.
                if (promotion.endsAt < now) continue
            } else if (promotion.startsAt > periodStart || promotion.endsAt < periodStart) {
                // Only settle a window this promotion was already live at the
                // start of. Without this, a promotion created today would on its
                // very first hourly run pay out on yesterday's losses — play it
                // never advertised cashback for — and every promotion alive at
                // deploy time would do exactly that at once.
                continue
            }

            const result = await CashbackService.checkAndDisburse(promotion.id, periodStart, periodEnd)
            totalDisbursed += result.disbursed
            totalAmount = totalAmount.plus(result.total)
            settlements.push({
                promotionId: promotion.id,
                name: promotion.name,
                payoutTiming,
                periodStart,
                periodEnd,
                disbursed: result.disbursed,
                skipped: result.skipped,
                budgetSkipped: result.budgetSkipped,
                total: result.total,
            })
        }

        return { promotionsChecked: activePromotions.length, totalDisbursed, totalAmount, settlements }
    }

    /**
     * The window a period's loss is actually measured over: the period
     * intersected with the promotion's own life. Play before a promotion
     * started, or after it ended, never earned cashback — and a PERIOD_CLOSE
     * promotion is settled after its own endsAt by design, so without the end
     * clamp its final settlement pays for the rest of a window it was already
     * dead for. Every caller of getNetLossByUser goes through this, or the
     * figure a progress bar shows is not the figure that will be paid.
     *
     * The periodStart used as the (promotionId, userId, periodStart) idempotency
     * key is deliberately NOT this clamped start: a promotion beginning
     * mid-window must keep settling under the canonical window start, or every
     * later run would pay again under a second key.
     */
    static lossWindow(
        promotion: { startsAt: Date; endsAt: Date },
        periodStart: Date,
        periodEnd: Date,
    ): { lossStart: Date; lossEnd: Date } {
        return {
            lossStart: promotion.startsAt > periodStart ? promotion.startsAt : periodStart,
            lossEnd: promotion.endsAt < periodEnd ? promotion.endsAt : periodEnd,
        }
    }

    /**
     * Net loss per user within [periodStart, periodEnd], restricted to the
     * promotion's game scope. Empty templateIds AND empty providerGameKeys
     * means unscoped — every bingo and provider game counts, matching
     * site-wide behavior.
     *
     * "Loss" here is strictly REAL-balance loss, which is what
     * `cashback_promotions.lossThreshold` documents itself as holding:
     *
     *  - a GAME_ENTRY contributes only the part that came out of realBalance.
     *    joinGame spends the bonus wallet first when spendAccount = 'BONUS' and
     *    snapshots it in bonusBalanceBefore/After, so counting the whole stake
     *    would recycle bonus into more bonus, forever.
     *  - a provider bet is the same story, one table further away: its
     *    third_party_transactions row only knows the combined balance, so the
     *    bonus-funded part is read off the paired TP_* transactions row instead.
     *  - a cancelled game leaves its GAME_ENTRY row APPROVED and books a
     *    separate REFUND row against the same gameId, so the refunded real
     *    portion comes back off the loss. REFUND is also used for withdrawal
     *    reversals and tournament exits, hence the `g.id IS NOT NULL` guard:
     *    only refunds that resolve to a game are game refunds.
     *
     * `userId` narrows the whole thing to one player. The hourly disburser wants
     * every player; a per-player progress bar wants one, and unbound this is a
     * site-wide GROUP BY that a single authenticated request would pay for.
     */
    static async getNetLossByUser(
        promotion: { templateIds: string[]; providerGameKeys: string[] },
        periodStart: Date,
        periodEnd: Date,
        userId?: string,
    ): Promise<Map<string, Decimal>> {
        const templateIds = promotion.templateIds ?? []
        const providerGameKeys = promotion.providerGameKeys ?? []
        const unscoped = templateIds.length === 0 && providerGameKeys.length === 0

        const providerPairs = providerGameKeys
            .map((key) => {
                const separatorIndex = key.indexOf(':')
                if (separatorIndex === -1) return null
                return { providerId: key.slice(0, separatorIndex), gameCode: key.slice(separatorIndex + 1) }
            })
            .filter((pair): pair is { providerId: string; gameCode: string } => pair !== null)

        // Unscoped means "no restriction", NOT "bingo only" — the provider CTE
        // has to stay open too, or a promotion with no game scope would ignore
        // provider play entirely while claiming to be site-wide.
        const bingoFilter = unscoped
            ? Prisma.empty
            : templateIds.length > 0
              ? Prisma.sql`AND g."templateId" = ANY(${templateIds}::text[])`
              : Prisma.sql`AND false`

        const providerFilter = unscoped
            ? Prisma.empty
            : providerPairs.length > 0
              ? Prisma.sql`AND (tpt."providerId", tpt."gameCode") IN (${Prisma.join(
                    providerPairs.map((p) => Prisma.sql`(${p.providerId}, ${p.gameCode})`),
                )})`
              : Prisma.sql`AND false`

        // Both CTEs have to carry the same player predicate. Binding it to only
        // one would silently return that player's bingo loss plus the whole
        // site's provider loss, which reads as a qualifying loss for everyone.
        const bingoUserFilter = userId ? Prisma.sql`AND t."userId" = ${userId}` : Prisma.empty
        const providerUserFilter = userId ? Prisma.sql`AND tpt."userId" = ${userId}` : Prisma.empty

        // "createdAt" is `timestamp` WITHOUT time zone holding UTC. Binding a JS
        // Date sends it as timestamptz, which Postgres reconciles through the
        // SESSION timezone — silently shifting the window on any session not
        // pinned to UTC. Bind the ISO string and cast, as bonus.service.ts does.
        const startUtc = periodStart.toISOString()
        const endUtc = periodEnd.toISOString()

        const rows = await prisma.$queryRaw<Array<{ userId: string; netLoss: Decimal }>>(Prisma.sql`
            WITH bingo_loss AS (
                SELECT t."userId",
                       SUM(CASE t.type
                               WHEN 'GAME_ENTRY' THEN GREATEST(
                                   t.amount - GREATEST(COALESCE(t."bonusBalanceBefore", 0) - COALESCE(t."bonusBalanceAfter", 0), 0),
                                   0
                               )
                               WHEN 'PRIZE_WIN' THEN -t.amount
                               WHEN 'REFUND' THEN -GREATEST(COALESCE(t."balanceAfter" - t."balanceBefore", t.amount), 0)
                               ELSE 0
                           END) AS "netLoss"
                FROM transactions t
                LEFT JOIN games g ON g.id = t."referenceId"
                WHERE t.status = 'APPROVED'
                  AND t."createdAt" BETWEEN ${startUtc}::timestamp AND ${endUtc}::timestamp
                  AND (t.type IN ('GAME_ENTRY', 'PRIZE_WIN') OR (t.type = 'REFUND' AND g.id IS NOT NULL))
                  ${bingoUserFilter}
                  ${bingoFilter}
                GROUP BY t."userId"
            ),
            provider_rows AS (
                SELECT tpt."userId", tpt."transactionId", tpt.amount
                FROM third_party_transactions tpt
                -- A rollback flips the original BET to ROLLED_BACK and books a
                -- compensating ROLLBACK row for the same money, split across the same
                -- two accounts, so the pair always nets to exactly zero. Dropping both
                -- halves is therefore arithmetically identical to keeping both, and it
                -- sidesteps a scope trap: Atlas-V's game_code is optional on a cancel,
                -- and a (providerId, gameCode) IN (...) test never matches a NULL, so a
                -- scoped promotion would have admitted the rolled-back bet while
                -- dropping its own refund, billing the player's cancelled stake as a
                -- real loss. It also stops a bet and its later cancel landing in two
                -- different periods, which would pay cashback on returned money.
                -- An unpaired ROLLBACK is always amount 0 (every provider records one
                -- so retries short-circuit, and never credits without a verified bet),
                -- so nothing real is lost by excluding the type outright. FAILED rows
                -- are inert for the same reason: amount 0, no paired audit row.
                WHERE tpt.status = 'COMPLETED'
                  AND tpt.type <> 'ROLLBACK'
                  AND tpt."createdAt" BETWEEN ${startUtc}::timestamp AND ${endUtc}::timestamp
                  ${providerUserFilter}
                  ${providerFilter}
            ),
            provider_bonus AS (
                -- third_party_transactions.balanceBefore/After hold the COMBINED
                -- real+bonus total, so a bonus-funded spin is indistinguishable from a
                -- real-funded one in that table — and all three provider integrations
                -- debit the bonus wallet when spendAccount = 'BONUS'. The paired wallet
                -- audit row each provider write site commits in the same transaction
                -- (transactions."referenceId" = the provider transactionId, type TP_*)
                -- is the only place that split survives.
                -- Pre-aggregated per (referenceId, userId) so the LEFT JOIN below cannot
                -- multiply a provider row against a stray duplicate audit row, and
                -- semi-joined to provider_rows rather than run per row: transactions has
                -- no index on referenceId, so a correlated subquery here is one scan of
                -- the table per provider row.
                SELECT pair."referenceId" AS "transactionId", pair."userId",
                       SUM(COALESCE(pair."bonusBalanceBefore", 0) - COALESCE(pair."bonusBalanceAfter", 0)) AS "bonusSpent"
                FROM transactions pair
                WHERE pair.status = 'APPROVED'
                  AND pair.type IN ('TP_BET', 'TP_WIN', 'TP_ADJUSTMENT')
                  AND pair."referenceId" IN (SELECT "transactionId" FROM provider_rows)
                GROUP BY pair."referenceId", pair."userId"
            ),
            provider_loss AS (
                -- The bonus-funded part comes off the loss exactly as the bingo CTE
                -- takes it off a GAME_ENTRY. No paired row at all (data predating this
                -- pairing) leaves the row wholly real, which is what this CTE assumed
                -- for every row before the split existed.
                SELECT r."userId", SUM(-r.amount - COALESCE(b."bonusSpent", 0)) AS "netLoss"
                FROM provider_rows r
                LEFT JOIN provider_bonus b
                       ON b."transactionId" = r."transactionId"
                      AND b."userId" = r."userId"
                GROUP BY r."userId"
            )
            SELECT "userId", SUM("netLoss") AS "netLoss"
            FROM (SELECT * FROM bingo_loss UNION ALL SELECT * FROM provider_loss) combined
            GROUP BY "userId"
        `)

        const result = new Map<string, Decimal>()
        for (const row of rows) {
            result.set(row.userId, new Decimal(row.netLoss))
        }
        return result
    }

    /**
     * Bots play with house money and would otherwise soak up a real budget.
     */
    private static async withoutBots(netLossByUser: Map<string, Decimal>): Promise<Map<string, Decimal>> {
        const userIds = [...netLossByUser.keys()]
        if (userIds.length === 0) return netLossByUser

        const botUsers = await prisma.user.findMany({
            where: { id: { in: userIds }, username: { startsWith: 'bot_t' } },
            select: { id: true },
        })
        if (botUsers.length === 0) return netLossByUser

        const filtered = new Map(netLossByUser)
        for (const bot of botUsers) filtered.delete(bot.id)
        return filtered
    }

    /**
     * One player's payout for a given net loss, capped by maxPayoutPerPlayer.
     *
     * Rounded down to 2dp: a PERCENTAGE payout can otherwise carry more
     * precision than bonus_grants' Decimal(12,2) can hold, silently truncating
     * there while wallets.bonusBalance (Decimal(20,8)) keeps the extra digits —
     * permanent drift on every percentage disbursement. BonusService.grant()
     * also rounds defensively, so this is belt-and-suspenders for this call site.
     */
    private static payoutFor(promotion: PayoutConfig, netLoss: Decimal): Decimal {
        const refundValue = new Decimal(promotion.refundValue)
        const raw =
            promotion.refundType === CashbackRefundType.PERCENTAGE
                ? netLoss.times(refundValue.div(100)).toDecimalPlaces(2, Decimal.ROUND_DOWN)
                : refundValue

        if (promotion.maxPayoutPerPlayer == null) return raw
        const cap = new Decimal(promotion.maxPayoutPerPlayer).toDecimalPlaces(2, Decimal.ROUND_DOWN)
        return raw.gt(cap) ? cap : raw
    }

    /**
     * Check and disburse cashback for one promotion within one period window.
     * Idempotent: safe to call multiple times for the same (promotionId,
     * periodStart) — which is exactly what a PERIOD_CLOSE promotion relies on,
     * since every hourly run for the rest of the day re-settles the same closed
     * window. The unique index on (promotionId, userId, periodStart) is the
     * guarantee; the pre-read below is only the cheap pass that also tells the
     * budget how much of itself an earlier run already spent.
     */
    static async checkAndDisburse(
        promotionId: string,
        periodStart: Date,
        periodEnd: Date,
    ): Promise<CashbackDisburseResult> {
        const promotion = await prisma.cashbackPromotion.findUnique({ where: { id: promotionId } })
        if (!promotion || !promotion.isActive) return { disbursed: 0, skipped: 0, budgetSkipped: 0, total: new Decimal(0) }

        const { lossStart, lossEnd } = CashbackService.lossWindow(promotion, periodStart, periodEnd)

        const netLossByUser = await CashbackService.withoutBots(
            await CashbackService.getNetLossByUser(promotion, lossStart, lossEnd),
        )

        const lossThreshold = new Decimal(promotion.lossThreshold)

        // Descending net loss, so a budget too small for everyone buys the
        // biggest losses rather than whichever userId Postgres returned first.
        const candidates = [...netLossByUser]
            .filter(([, netLoss]) => netLoss.gte(lossThreshold)) // inclusive boundary
            .sort((a, b) => b[1].comparedTo(a[1]))

        const priorDisbursements = await prisma.cashbackDisbursement.findMany({
            where: { promotionId, periodStart },
            select: { userId: true, amount: true },
        })
        const alreadyPaid = new Set(priorDisbursements.map((d) => d.userId))

        const budget = promotion.periodBudget == null ? null : new Decimal(promotion.periodBudget)
        let spent = priorDisbursements.reduce((sum, d) => sum.plus(new Decimal(d.amount)), new Decimal(0))

        // One instant for the whole settlement, so every lot it grants dies
        // together rather than drifting apart by however long the loop took.
        const payoutAt = new Date()
        const expiresAt =
            promotion.bonusValidityHours > 0
                ? new Date(payoutAt.getTime() + promotion.bonusValidityHours * 60 * 60 * 1000)
                : null

        let disbursed = 0
        let skipped = 0
        let budgetSkipped = 0
        let total = new Decimal(0)

        for (let i = 0; i < candidates.length; i++) {
            const [userId, netLoss] = candidates[i]
            if (alreadyPaid.has(userId)) {
                skipped++
                continue
            }

            const cashbackAmount = CashbackService.payoutFor(promotion, netLoss)
            if (cashbackAmount.lte(0)) continue

            if (budget && spent.plus(cashbackAmount).gt(budget)) {
                // Stop rather than skip-and-continue: paying a smaller qualifier
                // further down the list because it happens to fit under the
                // remainder would hand the budget to the wrong players.
                budgetSkipped = candidates.slice(i).filter(([id]) => !alreadyPaid.has(id)).length
                // A truncated payout run otherwise reads as "everyone was paid".
                console.warn(
                    `[Cashback] "${promotion.name}" reached its ${budget.toFixed(2)} budget for the period ` +
                    `starting ${periodStart.toISOString()} — ${budgetSkipped} qualifying player(s) unpaid ` +
                    `(${spent.toFixed(2)} disbursed)`,
                )
                break
            }

            const result = await prisma.$transaction(async (tx) => {
                // Idempotency: unique constraint on (promotionId, userId, periodStart)
                const existing = await tx.cashbackDisbursement.findUnique({
                    where: {
                        promotionId_userId_periodStart: { promotionId, userId: userId, periodStart },
                    },
                })
                if (existing) return 'skipped'

                // BonusService.grant() reads the wallet with a plain, unlocked
                // SELECT — it assumes the caller already holds a FOR UPDATE lock
                // on the wallet row in this same transaction (the Global
                // Constraint every other BonusService caller follows; see
                // game.service.ts's joinGame). Without it, two disbursements
                // racing for the same player can each read a stale
                // bonusBalance and record a wrong bonusBalanceBefore in their
                // audit row.
                await tx.$queryRaw`
                    SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                `

                const grantResult = await BonusService.grant(tx, {
                    userId: userId,
                    amount: cashbackAmount,
                    source: 'CASHBACK',
                    expiresAt,
                })
                if (!grantResult.granted) return 'skipped'

                await tx.transaction.create({
                    data: {
                        userId: userId,
                        type: TransactionType.CASHBACK_BONUS,
                        amount: cashbackAmount,
                        status: PaymentStatus.APPROVED,
                        referenceId: promotionId,
                        note: `Cashback: ${promotion.name}`,
                        balanceBefore: grantResult.bonusBalanceBefore,
                        balanceAfter: grantResult.bonusBalanceBefore,
                        bonusBalanceBefore: grantResult.bonusBalanceBefore,
                        bonusBalanceAfter: grantResult.bonusBalanceAfter,
                    },
                })

                // Record disbursement
                await tx.cashbackDisbursement.create({
                    data: {
                        promotionId,
                        userId: userId,
                        amount: cashbackAmount,
                        periodStart,
                        periodEnd,
                    },
                })

                return cashbackAmount
            })

            if (result === 'skipped') {
                skipped++
            } else {
                disbursed++
                total = total.plus(result as Decimal)
                spent = spent.plus(result as Decimal)
                void captureEvent(userId, 'bonus_granted', {
                    amount: Number(result as Decimal),
                    source: 'CASHBACK',
                    rule_id: promotionId,
                })

                // Push notification (fire-and-forget)
                NotificationService.create(
                    userId,
                    NotificationType.CASHBACK_AWARDED,
                    'Cashback Bonus!',
                    `You received ${Number(result as Decimal).toFixed(2)} ETB cashback from "${promotion.name}".`,
                    { promotionId, amount: (result as Decimal).toFixed(2) },
                ).catch(() => {})
            }
        }

        return { disbursed, skipped, budgetSkipped, total }
    }

    /**
     * What the OPEN period would pay if it closed right now — the admin detail
     * screen's "Qualifies right now" panel.
     *
     * The per-player cap is applied because it changes what each player is owed.
     * The period budget deliberately is NOT: the screen shows the over-budget
     * delta itself, which needs the untruncated total to subtract from.
     */
    static async previewQualifiers(promotionId: string, now = new Date()): Promise<CashbackPreview> {
        const promotion = await prisma.cashbackPromotion.findUniqueOrThrow({ where: { id: promotionId } })
        const { periodStart, periodEnd } = getCurrentPeriod(promotion.frequency as CashbackFrequency, now)
        const { lossStart, lossEnd } = CashbackService.lossWindow(promotion, periodStart, periodEnd)

        const netLossByUser = await CashbackService.withoutBots(
            await CashbackService.getNetLossByUser(promotion, lossStart, lossEnd),
        )
        const lossThreshold = new Decimal(promotion.lossThreshold)

        const qualifiers = [...netLossByUser]
            .filter(([, netLoss]) => netLoss.gte(lossThreshold))
            .map(([userId, netLoss]) => ({ userId, netLoss, payout: CashbackService.payoutFor(promotion, netLoss) }))
            .filter((q) => q.payout.gt(0))
            .sort((a, b) => b.netLoss.comparedTo(a.netLoss))

        const projectedTotal = qualifiers.reduce((sum, q) => sum.plus(q.payout), new Decimal(0))
        const largest = qualifiers.reduce((max, q) => (q.payout.gt(max) ? q.payout : max), new Decimal(0))

        const topQualifiers = qualifiers.slice(0, 5)
        const users = topQualifiers.length > 0
            ? await prisma.user.findMany({
                  where: { id: { in: topQualifiers.map((q) => q.userId) } },
                  select: { id: true, username: true },
              })
            : []
        const usernameById = new Map(users.map((u) => [u.id, u.username]))

        return {
            periodStart,
            periodEnd,
            players: qualifiers.length,
            projectedTotal,
            largest,
            top: topQualifiers.map((q) => ({
                username: usernameById.get(q.userId) ?? 'Unknown player',
                netLoss: q.netLoss,
                payout: q.payout,
            })),
        }
    }
}
