import prisma from '../lib/prisma'

export interface ActiveBonusGrantView {
    id: string
    amount: number
    remaining: number
    expiresAt: string | null
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
            ruleName: g.rule?.name ?? null,
            createdAt: g.createdAt.toISOString(),
        }))
    }
}
