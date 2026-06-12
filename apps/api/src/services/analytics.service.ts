import { Prisma } from '@prisma/client'
import prisma from '../lib/prisma'

// Excludes bot accounts (username bot_t<templateId>_<slot>) and staff roles.
// username is nullable (Telegram-only users), hence the IS NULL branch.
const NON_BOT_PLAYER = Prisma.sql`u."role" = 'PLAYER' AND (u."username" IS NULL OR u."username" NOT LIKE 'bot_t%')`

export class AnalyticsService {
    static parseRange(fromStr?: string, toStr?: string, now: Date = new Date()) {
        const to = toStr ? new Date(toStr) : now
        const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 30 * 24 * 3600 * 1000)
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Invalid date')
        if (from.getTime() >= to.getTime()) throw new Error('from must be before to')
        return { from, to }
    }

    static pct(num: number, den: number): number {
        if (!den) return 0
        return Math.round((num / den) * 1000) / 10
    }

    static buildRetentionMatrix(
        sizes: Array<{ cohort_week: Date; size: number }>,
        activity: Array<{ cohort_week: Date; week_offset: number; active_users: number }>,
        maxOffsets: number,
    ) {
        return sizes.map(({ cohort_week, size }) => {
            const key = cohort_week.getTime()
            const offsets = Array.from({ length: maxOffsets }, (_, i) => {
                const hit = activity.find(a => a.cohort_week.getTime() === key && a.week_offset === i)
                return this.pct(hit?.active_users ?? 0, size)
            })
            return { week: cohort_week.toISOString().slice(0, 10), size, offsets }
        })
    }
}
