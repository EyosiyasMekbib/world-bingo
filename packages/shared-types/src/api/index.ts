import { z } from 'zod'
import { PatternType, PaymentStatus, TournamentStatus } from '../enums'

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
export type CreateGameDto = z.infer<typeof CreateGameSchema>
export type DepositDto = z.infer<typeof DepositSchema>
export type WithdrawalDto = z.infer<typeof WithdrawalSchema>
export type ReviewDepositDto = z.infer<typeof ReviewDepositSchema>
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

