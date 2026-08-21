import prisma from '../lib/prisma'
import type { BonusRule } from '@prisma/client'
import { compileSegment } from './player-crm/segment-compiler'
import { parseSegmentRuleSet } from '@world-bingo/shared-types'

export interface CreateBonusRuleInput {
    name: string
    type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
    threshold: number
    rewardType: 'FIXED' | 'PERCENTAGE'
    rewardValue: number
    maxReward?: number | null
    validityHours: number
    startsAt: string
    endsAt: string
    segmentId?: string | null
}

export class BonusRuleService {
    /**
     * Creates a rule and, when a segment is given, materializes its frozen
     * member cohort in the same transaction. Membership is resolved exactly
     * once here and never recomputed — see the design spec §3.
     */
    static async create(input: CreateBonusRuleInput): Promise<BonusRule> {
        const data = {
            name: input.name,
            type: input.type,
            threshold: input.threshold,
            rewardType: input.rewardType,
            rewardValue: input.rewardValue,
            maxReward: input.maxReward ?? null,
            validityHours: input.validityHours,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
        }

        if (!input.segmentId) {
            return prisma.bonusRule.create({ data })
        }

        const segment = await prisma.segment.findUnique({ where: { id: input.segmentId } })
        if (!segment) throw new Error('Segment not found')

        const where = compileSegment(parseSegmentRuleSet(segment.rules))
        const matches = await prisma.playerMetrics.findMany({ where, select: { userId: true } })
        if (matches.length === 0) {
            throw new Error(`Segment "${segment.name}" matches no players — this rule could never pay anyone`)
        }

        return prisma.$transaction(async (tx) => {
            const rule = await tx.bonusRule.create({
                data: {
                    ...data,
                    isSegmentScoped: true,
                    segmentId: segment.id,
                    segmentName: segment.name,
                    memberCount: matches.length,
                },
            })

            // Batched: a large segment is tens of thousands of rows, and a single
            // createMany with that many values risks exceeding Postgres's bind
            // parameter limit.
            const CHUNK = 5_000
            for (let i = 0; i < matches.length; i += CHUNK) {
                await tx.bonusRuleMember.createMany({
                    data: matches.slice(i, i + CHUNK).map((m) => ({ ruleId: rule.id, userId: m.userId })),
                    skipDuplicates: true,
                })
            }

            return rule
        })
    }

    static async update(id: string, input: Partial<CreateBonusRuleInput> & { isActive?: boolean }): Promise<BonusRule> {
        return prisma.bonusRule.update({
            where: { id },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.type !== undefined ? { type: input.type } : {}),
                ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
                ...(input.rewardType !== undefined ? { rewardType: input.rewardType } : {}),
                ...(input.rewardValue !== undefined ? { rewardValue: input.rewardValue } : {}),
                ...(input.maxReward !== undefined ? { maxReward: input.maxReward } : {}),
                ...(input.validityHours !== undefined ? { validityHours: input.validityHours } : {}),
                ...(input.startsAt !== undefined ? { startsAt: new Date(input.startsAt) } : {}),
                ...(input.endsAt !== undefined ? { endsAt: new Date(input.endsAt) } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            },
        })
    }

    static async list(): Promise<BonusRule[]> {
        return prisma.bonusRule.findMany({ orderBy: { createdAt: 'desc' } })
    }

    static async listActive(now: Date): Promise<BonusRule[]> {
        return prisma.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
            orderBy: { createdAt: 'desc' },
        })
    }
}
