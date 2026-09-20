import type { BonusSource } from '@prisma/client'
import prisma from '../lib/prisma'

export interface ActiveBonusGrantView {
    id: string
    amount: number
    remaining: number
    expiresAt: string | null
    /**
     * Where the money came from. A cashback, welcome or campaign lot carries no
     * ruleId, so `ruleName` is null for all three and the wallet cannot tell
     * them apart without this — every lot renders as one anonymous "Bonus".
     */
    source: BonusSource
    ruleName: string | null
    createdAt: string
}

export class BonusGrantQueryService {
    static async listActiveForUser(userId: string): Promise<ActiveBonusGrantView[]> {
        const grants = await prisma.bonusGrant.findMany({
            where: { userId, status: 'ACTIVE' },
            orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
            include: { rule: { select: { name: true } } },
        })

        return grants.map((g) => ({
            id: g.id,
            amount: Number(g.amount),
            remaining: Number(g.remaining),
            expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
            source: g.source,
            ruleName: g.rule?.name ?? null,
            createdAt: g.createdAt.toISOString(),
        }))
    }
}
