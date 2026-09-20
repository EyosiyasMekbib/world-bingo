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
 * Plain "what to do next" appended to the label above, in the deposit
 * rejection notification (web + Telegram) and the wallet page. Kept apart
 * from the label itself so the label can stay a short reviewer-facing
 * category while this stays an instruction.
 */
export const DEPOSIT_REJECTION_NEXT_STEP: Record<DepositRejectionReason, string> = {
    [DepositRejectionReason.DUPLICATE_RECEIPT]:
        'That transaction ID was already credited. If you sent money again, submit the new receipt.',
    [DepositRejectionReason.AMOUNT_MISMATCH]:
        'Resubmit with the exact amount shown on your receipt.',
    [DepositRejectionReason.PAYER_MISMATCH]:
        'Deposit from an account in your own name, or contact support if it already is.',
    [DepositRejectionReason.UNREADABLE_RECEIPT]:
        'Resubmit a clear photo or screenshot of the receipt.',
    [DepositRejectionReason.NOT_FOUND]:
        'Double-check the transaction ID and resubmit — it did not match any transfer we could find.',
    [DepositRejectionReason.OTHER]: 'See the note above, or contact support.',
}

/**
 * Player-facing wording for AccountStatusChange.category (RESTRICTED /
 * SUSPENDED reason bucket). Deliberately coarser than the free-text `reason`
 * column, which is staff-internal and never shown to the player. Mirrors the
 * comment on AccountStatusChange.category in schema.prisma and
 * AccountStatusService.STATUS_CATEGORIES — change all three together.
 */
export const STATUS_CATEGORY_LABELS: Record<string, string> = {
    RECEIPT_FRAUD: 'a deposit receipt under review',
    CHARGEBACK: 'a payment dispute',
    BONUS_ABUSE: 'bonus terms',
    MULTI_ACCOUNT: 'multiple accounts',
    OTHER: 'an account review',
}

/** GET /user/account-status. */
export interface AccountStatusInfo {
    status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED'
    /** One of STATUS_CATEGORY_LABELS' keys, or null when not ACTIVE but no
     *  category was recorded (a transition made before categories existed). */
    category: string | null
    /** When set, the account restores itself automatically at this time. */
    expiresAt: string | null
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

// ─── Telegram support bot ───────────────────────────────────────────────────
// This is the SUPPORT BOT link (User.telegramChatId), not the login widget
// above (User.telegramId). Linking here never enables Telegram sign-in.

/** POST /support/telegram/link response. Null when the bot is not
 *  configured for this deployment. */
export interface TelegramLinkResponse {
    deepLink: string | null
}

export const TelegramNotifyPatchSchema = z.object({
    notifyEnabled: z.boolean(),
})
export type TelegramNotifyPatchDto = z.infer<typeof TelegramNotifyPatchSchema>

/**
 * POST /auth/password-reset/consume. `token` is the one-time value from the
 * bot's reset link (services/telegram/link.service.ts), never a password.
 */
export const PasswordResetConsumeSchema = z.object({
    token: z.string().min(16).max(128),
    newPassword: z.string().min(6),
})
export type PasswordResetConsumeDto = z.infer<typeof PasswordResetConsumeSchema>

/** Same shape as ChangePasswordResponse — this device is signed in with a
 *  fresh session once the reset is consumed. */
export interface PasswordResetConsumeResponse {
    message: string
    user: User
    accessToken: string
    refreshToken: string
}

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

