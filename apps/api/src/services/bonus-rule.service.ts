import prisma from '../lib/prisma'
import type { BonusRule } from '@prisma/client'

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
}

export class BonusRuleService {
    static async create(input: CreateBonusRuleInput): Promise<BonusRule> {
        return prisma.bonusRule.create({
            data: {
                name: input.name,
                type: input.type,
                threshold: input.threshold,
                rewardType: input.rewardType,
                rewardValue: input.rewardValue,
                maxReward: input.maxReward ?? null,
                validityHours: input.validityHours,
                startsAt: new Date(input.startsAt),
                endsAt: new Date(input.endsAt),
            },
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
