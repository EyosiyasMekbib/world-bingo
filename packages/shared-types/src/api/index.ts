import { z } from 'zod'
import { DepositRejectionReason, PatternType, PaymentStatus, TournamentStatus } from '../enums'
import type { User } from '../entities'

export const LoginSchema = z.object({
    identifier: z.string().min(2).max(32).describe('Username or phone number'),
    password: z.string().min(6),
})

export const RegisterSchema = z.object({
    username: z.string().min(2).max(32),
    phone: z.string().min(9).max(15),
    password: z.string().min(6),
    referralCode: z.string().min(6).max(12).optional(),
})

export const RefreshTokenSchema = z.object({
    refreshToken: z.string().min(1),
})

export const LogoutSchema = z.object({
    refreshToken: z.string().min(1),
})

export const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(6),
    newPassword: z.string().min(6),
})

export const CreateGameSchema = z.object({
    title: z.string().min(3).max(64),
    ticketPrice: z.number().positive(),
    maxPlayers: z.number().int().min(2).max(500),
    minPlayers: z.number().int().min(2).default(2),
    houseEdgePct: z.number().min(0).max(50).default(10),
    pattern: z.nativeEnum(PatternType),
})

export const DepositSchema = z.object({
    amount: z.number().positive(),
    receiptUrl: z.string().url().optional(),
    transactionId: z.string().min(5).optional(),
    senderName: z.string().min(1).optional(),
    senderAccount: z.string().min(10).optional(),
    methodCode: z.string().optional(),
})

export const CheckoutSessionSchema = z.object({
    amount: z.number().positive(),
    methodCode: z.string().min(1),
})

export const ClaimCheckoutSchema = z.object({
    depositId: z.string().min(3),
})

export const WithdrawalSchema = z.object({
    amount: z.number().min(100, 'Minimum withdrawal is 100 Birr'),
    paymentMethod: z.string().min(3),
    accountNumber: z.string().min(5),
})

export const ReviewDepositSchema = z.object({
    transactionId: z.string().uuid(),
    status: z.enum([PaymentStatus.APPROVED, PaymentStatus.REJECTED]),
    note: z.string().optional(),
})

/** Reviewer- and player-facing wording for each rejection reason. */
export const DEPOSIT_REJECTION_REASON_LABELS: Record<DepositRejectionReason, string> = {
    [DepositRejectionReason.DUPLICATE_RECEIPT]: 'Receipt already used',
    [DepositRejectionReason.AMOUNT_MISMATCH]: 'Amount does not match the receipt',
    [DepositRejectionReason.PAYER_MISMATCH]: 'Sender name or number does not match',
    [DepositRejectionReason.UNREADABLE_RECEIPT]: 'Receipt unreadable or not a receipt',
    [DepositRejectionReason.NOT_FOUND]: 'Transaction ID not found or does not match',
    [DepositRejectionReason.OTHER]: 'Other',
}

/**
 * Body of POST /admin/transactions/:id/decline. `reason` is optional here
 * because the same route rejects withdrawals; AdminService.reviewTransaction
 * requires it for deposits. OTHER must explain itself in `note`.
 */
export const DeclineTransactionSchema = z
    .object({
        reason: z.nativeEnum(DepositRejectionReason).optional(),
        note: z.string().trim().max(500).optional(),
    })
    .refine((v) => v.reason !== DepositRejectionReason.OTHER || (v.note ?? '').length > 0, {
        message: 'Add a note explaining the rejection when the reason is Other',
        path: ['note'],
    })

export const JoinGameSchema = z.object({
    gameId: z.string().uuid().optional(),
    cartelaSerials: z.array(z.string()).min(1).max(10),
})

export const ClaimBingoSchema = z.object({
    gameId: z.string().uuid(),
    cartelaId: z.string().uuid(),
})

export type LoginDto = z.infer<typeof LoginSchema>
export type RegisterDto = z.infer<typeof RegisterSchema>
export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>
export type LogoutDto = z.infer<typeof LogoutSchema>
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>

/**
 * POST /auth/change-password. Every other session is revoked; the tokens here
 * are this device's fresh session, and `user.mustChangePassword` is false.
 */
export interface ChangePasswordResponse {
    message: string
    user: User
    accessToken: string
    refreshToken: string
}

/** POST /admin/users/:id/reset-password. Shown to the admin once, never stored. */
export interface AdminResetPasswordResponse {
    temporaryPassword: string
}
export type CreateGameDto = z.infer<typeof CreateGameSchema>
export type DepositDto = z.infer<typeof DepositSchema>
export type WithdrawalDto = z.infer<typeof WithdrawalSchema>
export type ReviewDepositDto = z.infer<typeof ReviewDepositSchema>
export type DeclineTransactionDto = z.infer<typeof DeclineTransactionSchema>
export type JoinGameDto = z.infer<typeof JoinGameSchema>
export type ClaimBingoDto = z.infer<typeof ClaimBingoSchema>

export const TelegramAuthSchema = z.object({
    id: z.number(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    photo_url: z.string().optional(),
    auth_date: z.number(),
    hash: z.string(),
    phone_number: z.string().optional(),
})
export type TelegramAuthDto = z.infer<typeof TelegramAuthSchema>

// ─── Referral ─────────────────────────────────────────────────────────────────
/** Bonus awarded to referrer when their referee completes their first deposit */
export const REFERRAL_BONUS_ETB = 50

export interface ReferralStatsDto {
    referralCode: string
    referralLink: string
    totalReferrals: number
    pendingRewards: number
    paidRewards: number
    totalEarned: number
}

// ─── Tournament (T60) ─────────────────────────────────────────────────────────
export const CreateTournamentSchema = z.object({
    title: z.string().min(3).max(64),
    entryFee: z.number().positive(),
    maxPlayers: z.number().int().min(2).max(128).default(32),
    houseEdgePct: z.number().min(0).max(50).default(10),
    scheduledAt: z.string().datetime().optional(),
})

export type CreateTournamentDto = z.infer<typeof CreateTournamentSchema>

export interface TournamentDto {
    id: string
    title: string
    status: TournamentStatus
    entryFee: number
    maxPlayers: number
    currentPlayers: number
    prizePool: number
    houseEdgePct: number
    winnerId: string | null
    rounds: number
    scheduledAt: string | null
    startedAt: string | null
    endedAt: string | null
    createdAt: string
}

export interface TournamentEntryDto {
    id: string
    tournamentId: string
    userId: string
    username: string
    round: number
    eliminated: boolean
    score: number
    joinedAt: string
}

export interface TournamentLeaderboardEntry {
    rank: number
    userId: string
    username: string
    score: number
    eliminated: boolean
}

