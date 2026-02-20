import { z } from 'zod'
import { PatternType, PaymentStatus } from '../enums'

export const LoginSchema = z.object({
    phone: z.string().min(9).max(15),
    password: z.string().min(6),
})

export const RegisterSchema = z.object({
    username: z.string().min(2).max(32),
    phone: z.string().min(9).max(15),
    password: z.string().min(6),
})

export const CreateGameSchema = z.object({
    title: z.string().min(3).max(64),
    ticketPrice: z.number().positive(),
    maxPlayers: z.number().int().min(2).max(500),
    houseEdgePct: z.number().min(0).max(50).default(10),
    pattern: z.nativeEnum(PatternType),
})

export const DepositSchema = z.object({
    amount: z.number().positive(),
    receiptUrl: z.string().url(),
})

export const ReviewDepositSchema = z.object({
    transactionId: z.string().uuid(),
    status: z.enum([PaymentStatus.APPROVED, PaymentStatus.REJECTED]),
    note: z.string().optional(),
})

export const JoinGameSchema = z.object({
    gameId: z.string().uuid(),
    cartelaSerial: z.string(),
})

export const ClaimBingoSchema = z.object({
    gameId: z.string().uuid(),
    cartelaId: z.string().uuid(),
})

export type LoginDto = z.infer<typeof LoginSchema>
export type RegisterDto = z.infer<typeof RegisterSchema>
export type CreateGameDto = z.infer<typeof CreateGameSchema>
export type DepositDto = z.infer<typeof DepositSchema>
export type ReviewDepositDto = z.infer<typeof ReviewDepositSchema>
export type JoinGameDto = z.infer<typeof JoinGameSchema>
export type ClaimBingoDto = z.infer<typeof ClaimBingoSchema>
