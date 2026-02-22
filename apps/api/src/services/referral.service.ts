/**
 * T57 — Referral Service
 *
 * Manages referral codes, tracks referred users, and awards bonuses
 * when a referred user completes their first deposit.
 *
 * Bonus: 50 ETB credited to referrer's wallet.
 */
import crypto from 'crypto'
import prisma from '../lib/prisma'
import { NotificationType } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service'
import { REFERRAL_BONUS_ETB } from '@world-bingo/shared-types'

const BONUS = REFERRAL_BONUS_ETB

// ─── Code generation ──────────────────────────────────────────────────────────

/** Generates a short, human-readable unique referral code (e.g. "WB3FA29C"). */
function generateCode(): string {
    return 'WB' + crypto.randomBytes(3).toString('hex').toUpperCase()
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ReferralService {
    /**
     * Ensures the user has a referral code, creating one if they don't.
     * Returns the referral code.
     */
    static async ensureCode(userId: string): Promise<string> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { referralCode: true },
        })
        if (!user) throw new Error('User not found')
        if (user.referralCode) return user.referralCode

        // Retry on rare collision
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = generateCode()
            try {
                const updated = await prisma.user.update({
                    where: { id: userId },
                    data: { referralCode: code },
                    select: { referralCode: true },
                })
                return updated.referralCode!
            } catch {
                // unique constraint violation — try again
            }
        }
        throw new Error('Failed to generate a unique referral code')
    }

    /**
     * Resolves a referral code to the referrer's userId.
     * Returns null if the code doesn't exist.
     */
    static async resolveCode(code: string): Promise<string | null> {
        const user = await prisma.user.findUnique({
            where: { referralCode: code },
            select: { id: true },
        })
        return user?.id ?? null
    }

    /**
     * Returns the referral stats for a user (code, totals, earnings).
     */
    static async getStats(userId: string) {
        // Ensure code exists
        const code = await ReferralService.ensureCode(userId)

        const rewards = await prisma.referralReward.findMany({
            where: { referrerId: userId },
        })

        const totalReferrals = rewards.length
        const pendingRewards = rewards.filter((r) => !r.paid).reduce((s, r) => s + Number(r.amount), 0)
        const paidRewards = rewards.filter((r) => r.paid).reduce((s, r) => s + Number(r.amount), 0)
        const totalEarned = pendingRewards + paidRewards

        return {
            referralCode: code,
            referralLink: `https://worldbingo.et/ref/${code}`,
            totalReferrals,
            pendingRewards,
            paidRewards,
            totalEarned,
        }
    }

    /**
     * Called when a player's first deposit is APPROVED.
     * If the player was referred, award the referrer a 50 ETB bonus.
     *
     * Idempotent — the `refereeId` unique constraint on ReferralReward
     * prevents double-awarding.
     */
    static async processFirstDepositBonus(refereeId: string): Promise<void> {
        // Check if the referee was referred by someone
        const referee = await prisma.user.findUnique({
            where: { id: refereeId },
            select: { referredById: true, username: true },
        })
        if (!referee?.referredById) return

        // Check if this user already triggered a reward (idempotent guard)
        const existing = await prisma.referralReward.findUnique({
            where: { refereeId },
        })
        if (existing) return

        const referrerId = referee.referredById

        await prisma.$transaction(async (tx) => {
            // Create reward record
            await tx.referralReward.create({
                data: {
                    referrerId,
                    refereeId,
                    amount: BONUS,
                    paid: true,
                    paidAt: new Date(),
                },
            })

            // Credit the referrer's wallet
            await tx.wallet.update({
                where: { userId: referrerId },
                data: { balance: { increment: BONUS } },
            })

            // Record the bonus as a transaction on the referrer's account
            await tx.transaction.create({
                data: {
                    userId: referrerId,
                    type: 'PRIZE_WIN' as any, // closest semantic; or add REFERRAL_BONUS TransactionType
                    amount: BONUS,
                    status: 'APPROVED' as any,
                    note: `Referral bonus — ${referee.username} completed their first deposit`,
                    balanceBefore: undefined,
                    balanceAfter: undefined,
                },
            })
        })

        // Notify the referrer (non-critical — don't throw on failure)
        await NotificationService.create(
            referrerId,
            NotificationType.REFERRAL_BONUS,
            '🎉 Referral Bonus Earned!',
            `Your friend ${referee.username} completed their first deposit. You've earned ${BONUS} ETB!`,
            { refereeId, amount: BONUS },
        ).catch(() => {})
    }
}
