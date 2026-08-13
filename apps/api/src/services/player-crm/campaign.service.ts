import { createHash } from 'crypto'
import prisma from '../../lib/prisma'
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { compileSegment } from './segment-compiler'
import { parseSegmentRuleSet } from '@world-bingo/shared-types'
import { NotificationType, TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { getIo } from '../../lib/socket'
import { reportError } from '../../lib/sentry.js'

/**
 * Campaign lifecycle and delivery.
 *
 *   DRAFT → PENDING_APPROVAL → APPROVED → RUNNING → COMPLETED | FAILED | CANCELLED
 *
 * Two properties carry most of the safety:
 *
 * 1. **The approved artifact is the source of truth.** At approval the segment's
 *    rules and the evaluation instant are copied onto the campaign, and a hash is
 *    taken over {rules, actions, caps}. The drain compiles from that copy and
 *    re-verifies the hash under the campaign row lock, so editing the segment — or
 *    the amount — after approval cannot retarget or inflate a running campaign.
 *
 * 2. **Delivery rows are materialised up front and only ever updated.** Every
 *    recipient reaches a terminal state as an UPDATE of an existing row, so "who
 *    was in this campaign and what happened to them" is one query, and a stuck
 *    QUEUED row is the alarm for a lost job. Uniqueness keys on rootId, so cloning
 *    a stopped campaign cannot re-pay anyone the original already paid.
 */

export interface CampaignActions {
    message?: { title: string; body: string }
    bonus?: { amount: number }
}

/**
 * Phase 3 kill switch — OFF unless explicitly enabled.
 *
 * The grant path is built and tested, but bonus credit is only meaningfully
 * "not cash" if it cannot be converted back. Provider rollbacks still credit
 * REAL balance regardless of which bucket the bet drew from
 * (palace-wallet.service.ts, third-party-wallet.service.ts), so until that is
 * closed a bonus campaign is a cash campaign. Ships dark; flip only when the
 * conversion paths are shut.
 */
export function bonusGrantsEnabled(): boolean {
    return process.env.CRM_BONUS_GRANTS_ENABLED === 'true'
}

export class CampaignDisabledError extends Error {
    constructor() {
        super(
            'Bonus-grant campaigns are disabled. Set CRM_BONUS_GRANTS_ENABLED=true only after ' +
            'provider rollbacks stop crediting real balance for bonus-funded bets.',
        )
        this.name = 'CampaignDisabledError'
    }
}

const BATCH_SIZE = 500

/** Stable stringify so key order can never change a hash. */
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
        .join(',')}}`
}

export function approvalHashOf(input: {
    rules: unknown
    actions: unknown
    maxRecipients: number
    maxTotalBonus: unknown
    maxPerPlayer: unknown
}): string {
    return createHash('sha256')
        .update(
            canonical({
                rules: input.rules,
                actions: input.actions,
                maxRecipients: input.maxRecipients,
                maxTotalBonus: String(input.maxTotalBonus),
                maxPerPlayer: String(input.maxPerPlayer),
            }),
        )
        .digest('hex')
}

export type CapDecision =
    | { ok: true }
    | { ok: false; reason: 'PER_PLAYER_CAP' | 'CAMPAIGN_TOTAL_CAP' | 'RECIPIENT_CAP' }

/**
 * Pure so it can be tested exhaustively without a database. Called INSIDE the
 * transaction that holds the campaign row lock, against values read under that
 * lock — a cap evaluated only at launch time is not a cap.
 */
export function evaluateCaps(
    state: { grantedTotal: Decimal; sentCount: number; maxTotalBonus: Decimal; maxPerPlayer: Decimal; maxRecipients: number },
    amount: Decimal,
): CapDecision {
    if (amount.greaterThan(state.maxPerPlayer)) return { ok: false, reason: 'PER_PLAYER_CAP' }
    if (state.grantedTotal.plus(amount).greaterThan(state.maxTotalBonus)) {
        return { ok: false, reason: 'CAMPAIGN_TOTAL_CAP' }
    }
    if (state.sentCount >= state.maxRecipients) return { ok: false, reason: 'RECIPIENT_CAP' }
    return { ok: true }
}

export class CampaignService {
    static async create(input: {
        name: string
        segmentId: string
        actions: CampaignActions
        maxRecipients?: number
        maxTotalBonus?: number
        maxPerPlayer?: number
        actorId?: string | null
        actorName?: string | null
    }) {
        if (input.actions?.bonus?.amount && !bonusGrantsEnabled()) {
            throw new CampaignDisabledError()
        }

        const segment = await prisma.segment.findUnique({ where: { id: input.segmentId } })
        if (!segment) throw new Error('Segment not found')

        const id = crypto.randomUUID()
        return prisma.campaign.create({
            data: {
                id,
                // A fresh campaign is its own lineage root.
                rootId: id,
                name: input.name,
                segmentId: input.segmentId,
                actions: input.actions as never,
                // Snapshot placeholders until approval pins the real ones.
                segmentRulesSnapshot: segment.rules as never,
                asOf: new Date(),
                maxRecipients: input.maxRecipients ?? 1000,
                maxTotalBonus: new Decimal(input.maxTotalBonus ?? 0),
                maxPerPlayer: new Decimal(input.maxPerPlayer ?? 0),
                createdById: input.actorId ?? null,
                createdByUsername: input.actorName ?? null,
                lastEditedById: input.actorId ?? null,
            },
        })
    }

    /** Mutation is legal in DRAFT only — an approved campaign is frozen. */
    static async update(id: string, patch: Record<string, unknown>, actorId?: string | null) {
        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) throw new Error('Campaign not found')
        if (campaign.status !== 'DRAFT') {
            throw new Error(`Cannot edit a campaign in ${campaign.status}`)
        }
        return prisma.campaign.update({
            where: { id },
            data: { ...patch, lastEditedById: actorId ?? campaign.lastEditedById },
        })
    }

    static async submitForApproval(id: string) {
        const result = await prisma.campaign.updateMany({
            where: { id, status: 'DRAFT' },
            data: { status: 'PENDING_APPROVAL' },
        })
        if (!result.count) throw new Error('Campaign is not in DRAFT')
        return prisma.campaign.findUnique({ where: { id } })
    }

    /**
     * Approval pins the artifact. Four-eyes is checked against the author AND the
     * last editor — comparing only the original author lets someone edit a
     * colleague's draft and then approve their own work.
     */
    static async approve(id: string, actor: { id: string; username?: string | null; note?: string }) {
        const campaign = await prisma.campaign.findUnique({
            where: { id },
            include: { segment: true },
        })
        if (!campaign) throw new Error('Campaign not found')
        if (campaign.status !== 'PENDING_APPROVAL') {
            throw new Error(`Cannot approve a campaign in ${campaign.status}`)
        }
        if (actor.id === campaign.createdById || actor.id === campaign.lastEditedById) {
            throw new Error('A campaign must be approved by someone other than its author or last editor')
        }

        const actions = campaign.actions as CampaignActions
        const grantsMoney = !!actions.bonus?.amount
        // Re-checked at approval, not only at creation: a campaign drafted while
        // the flag was on must not become approvable after it is switched off.
        if (grantsMoney && !bonusGrantsEnabled()) throw new CampaignDisabledError()
        if (grantsMoney && !actor.note?.trim()) {
            throw new Error('An approval note is required for campaigns that grant bonus credit')
        }

        const rules = campaign.segment.rules
        const asOf = new Date()

        return prisma.campaign.update({
            where: { id },
            data: {
                status: 'APPROVED',
                segmentRulesSnapshot: rules as never,
                asOf,
                approvalHash: approvalHashOf({
                    rules,
                    actions: campaign.actions,
                    maxRecipients: campaign.maxRecipients,
                    maxTotalBonus: campaign.maxTotalBonus,
                    maxPerPlayer: campaign.maxPerPlayer,
                }),
                approvedById: actor.id,
                approvedByUsername: actor.username ?? null,
                approvalNote: actor.note?.trim() ?? null,
                approvedAt: asOf,
            },
        })
    }

    /**
     * Materialise the recipient list and move to RUNNING.
     *
     * The LIMIT is remaining capacity, not the raw cap: a retry after a crash
     * would otherwise select a partly-disjoint set and suppress only the overlap,
     * ending up above the approved ceiling.
     */
    static async launch(id: string): Promise<{ queued: number }> {
        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) throw new Error('Campaign not found')
        if (campaign.status !== 'APPROVED' && campaign.status !== 'RUNNING') {
            throw new Error(`Cannot launch a campaign in ${campaign.status}`)
        }

        const existing = await prisma.campaignDelivery.count({ where: { campaignId: id } })
        const remaining = Math.max(0, campaign.maxRecipients - existing)

        if (remaining > 0) {
            const where = compileSegment(parseSegmentRuleSet(campaign.segmentRulesSnapshot), {
                now: campaign.asOf,
            })

            const candidates = await prisma.playerMetrics.findMany({
                where: { ...where, isActive: true },
                select: { userId: true },
                orderBy: { userId: 'asc' },
                take: remaining,
            })

            if (candidates.length) {
                await prisma.campaignDelivery.createMany({
                    data: candidates.map((c) => ({
                        campaignId: id,
                        rootId: campaign.rootId,
                        userId: c.userId,
                        status: 'QUEUED' as const,
                    })),
                    // Skips anyone already delivered in this lineage.
                    skipDuplicates: true,
                })
            }
        }

        const queued = await prisma.campaignDelivery.count({
            where: { campaignId: id, status: 'QUEUED' },
        })
        const total = await prisma.campaignDelivery.count({ where: { campaignId: id } })

        await prisma.campaign.update({
            where: { id },
            data: {
                status: 'RUNNING',
                startedAt: campaign.startedAt ?? new Date(),
                snapshotSize: total,
                queuedCount: queued,
            },
        })

        return { queued }
    }

    /** Immediate stop. Money already moved is NOT clawed back automatically. */
    static async stop(id: string, reason = 'stopped by operator') {
        const result = await prisma.campaign.updateMany({
            where: { id, status: { in: ['RUNNING', 'APPROVED', 'PENDING_APPROVAL'] } },
            data: { status: 'CANCELLED', finishedAt: new Date() },
        })
        if (result.count) {
            // Un-processed rows become a terminal SKIPPED, so the campaign has no
            // rows left in limbo and the count reconciles.
            await prisma.campaignDelivery.updateMany({
                where: { campaignId: id, status: 'QUEUED' },
                data: { status: 'SKIPPED', skipReason: reason },
            })
        }
        return result.count > 0
    }

    /**
     * Process one batch. Returns how many rows were handled; 0 means done.
     *
     * Claim-then-process: a row moves QUEUED → its terminal state inside the same
     * transaction that does the work, so a crashed worker leaves the row QUEUED and
     * the next pass retries it.
     */
    static async drainBatch(id: string): Promise<{ processed: number; done: boolean }> {
        const campaign = await prisma.campaign.findUnique({ where: { id } })
        if (!campaign) throw new Error('Campaign not found')
        if (campaign.status !== 'RUNNING') return { processed: 0, done: true }

        // Re-verify the approved artifact before doing anything.
        const expected = approvalHashOf({
            rules: campaign.segmentRulesSnapshot,
            actions: campaign.actions,
            maxRecipients: campaign.maxRecipients,
            maxTotalBonus: campaign.maxTotalBonus,
            maxPerPlayer: campaign.maxPerPlayer,
        })
        if (campaign.approvalHash && campaign.approvalHash !== expected) {
            await prisma.campaign.update({
                where: { id },
                data: { status: 'FAILED', finishedAt: new Date() },
            })
            reportError(new Error('Campaign payload changed after approval'), {
                service: 'campaign',
                campaignId: id,
            })
            return { processed: 0, done: true }
        }

        const batch = await prisma.campaignDelivery.findMany({
            where: { campaignId: id, status: 'QUEUED' },
            take: BATCH_SIZE,
            orderBy: { createdAt: 'asc' },
        })

        if (!batch.length) {
            await prisma.campaign.update({
                where: { id },
                data: { status: 'COMPLETED', finishedAt: new Date() },
            })
            return { processed: 0, done: true }
        }

        const actions = campaign.actions as CampaignActions

        for (const delivery of batch) {
            await CampaignService.processDelivery(campaign.id, delivery.id, delivery.userId, actions)
        }

        await prisma.campaign.update({
            where: { id },
            data: { lastProgressAt: new Date() },
        })

        return { processed: batch.length, done: false }
    }

    private static async processDelivery(
        campaignId: string,
        deliveryId: string,
        userId: string,
        actions: CampaignActions,
    ): Promise<void> {
        try {
            await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
                // Liveness is re-checked live, not from the rollup: a freeze is a
                // raw UPDATE that bumps no timestamp, so the rollup copy can lag.
                const user = await tx.user.findUnique({
                    where: { id: userId },
                    select: { isActive: true, role: true, passwordHash: true, username: true },
                })

                const excluded =
                    !user ||
                    !user.isActive ||
                    user.role !== 'PLAYER' ||
                    user.passwordHash === 'BOT_ACCOUNT' ||
                    (user.username?.startsWith('bot_t') ?? false)

                if (excluded) {
                    await tx.campaignDelivery.update({
                        where: { id: deliveryId },
                        data: { status: 'SKIPPED', skipReason: 'EXCLUDED' },
                    })
                    await tx.campaign.update({
                        where: { id: campaignId },
                        data: { skippedCount: { increment: 1 } },
                    })
                    return
                }

                let notificationId: string | null = null
                let transactionId: string | null = null
                let bonusAmount: Decimal | null = null

                if (actions.message) {
                    const notification = await tx.notification.create({
                        data: {
                            userId,
                            type: NotificationType.CAMPAIGN_MESSAGE as never,
                            title: actions.message.title,
                            body: actions.message.body,
                            metadata: { campaignId } as never,
                        },
                    })
                    notificationId = notification.id
                }

                if (actions.bonus?.amount) {
                    const amount = new Decimal(actions.bonus.amount)

                    // Lock the campaign row and evaluate caps against what it says
                    // NOW — not against what it said at launch.
                    const rows = await tx.$queryRaw<
                        Array<{
                            grantedTotal: Decimal
                            sentCount: number
                            maxTotalBonus: Decimal
                            maxPerPlayer: Decimal
                            maxRecipients: number
                        }>
                    >`
                        SELECT "grantedTotal", "sentCount", "maxTotalBonus", "maxPerPlayer", "maxRecipients"
                        FROM campaigns WHERE id = ${campaignId} FOR UPDATE
                    `
                    const state = rows[0]
                    const decision = evaluateCaps(
                        {
                            grantedTotal: new Decimal(state.grantedTotal),
                            sentCount: state.sentCount,
                            maxTotalBonus: new Decimal(state.maxTotalBonus),
                            maxPerPlayer: new Decimal(state.maxPerPlayer),
                            maxRecipients: state.maxRecipients,
                        },
                        amount,
                    )

                    if (decision.ok === false) {
                        await tx.campaignDelivery.update({
                            where: { id: deliveryId },
                            data: { status: 'SKIPPED', skipReason: decision.reason },
                        })
                        await tx.campaign.update({
                            where: { id: campaignId },
                            data: { skippedCount: { increment: 1 } },
                        })
                        return
                    }

                    const wallets = await tx.$queryRaw<
                        Array<{ realBalance: Decimal; bonusBalance: Decimal }>
                    >`
                        SELECT "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
                    `
                    const wallet = wallets[0]
                    if (!wallet) throw new Error(`Wallet not found for ${userId}`)

                    const realBefore = new Decimal(wallet.realBalance)
                    const bonusBefore = new Decimal(wallet.bonusBalance)
                    const bonusAfter = bonusBefore.plus(amount)

                    await tx.wallet.update({
                        where: { userId },
                        data: { bonusBalance: bonusAfter },
                    })

                    const txn = await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.CAMPAIGN_BONUS as never,
                            amount,
                            status: PaymentStatus.APPROVED as never,
                            referenceId: campaignId,
                            note: '[Campaign] bonus grant',
                            balanceBefore: realBefore,
                            balanceAfter: realBefore,
                            bonusBalanceBefore: bonusBefore,
                            bonusBalanceAfter: bonusAfter,
                        },
                    })
                    transactionId = txn.id
                    bonusAmount = amount

                    // Counter moves in the SAME transaction as the money, so the
                    // running total can never lag behind what was actually paid.
                    await tx.campaign.update({
                        where: { id: campaignId },
                        data: { grantedTotal: { increment: amount } },
                    })
                }

                await tx.campaignDelivery.update({
                    where: { id: deliveryId },
                    data: { status: 'SENT', notificationId, transactionId, bonusAmount },
                })
                await tx.campaign.update({
                    where: { id: campaignId },
                    data: { sentCount: { increment: 1 } },
                })
            })

            // Socket push is best-effort and outside the transaction — a dropped
            // websocket must never roll back a payment.
            if (actions.message) {
                try {
                    getIo().to(`user:${userId}`).emit('notification:new', {
                        type: NotificationType.CAMPAIGN_MESSAGE,
                        title: actions.message.title,
                        body: actions.message.body,
                    } as never)
                } catch {
                    /* socket not initialised */
                }
            }
        } catch (err) {
            await prisma.campaignDelivery
                .update({
                    where: { id: deliveryId },
                    data: { status: 'FAILED', error: (err as Error).message.slice(0, 500) },
                })
                .catch(() => {})
            await prisma.campaign
                .update({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } })
                .catch(() => {})
            reportError(err, { service: 'campaign', action: 'delivery', campaignId, userId })
        }
    }
}
