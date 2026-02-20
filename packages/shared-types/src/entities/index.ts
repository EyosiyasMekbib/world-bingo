import type { GameStatus, UserRole, PatternType, TransactionType, PaymentStatus } from '../enums'

export interface User {
    id: string
    username: string
    phone: string
    email?: string
    role: UserRole
    avatarUrl?: string
    createdAt: Date
    updatedAt: Date
}

export interface Wallet {
    id: string
    userId: string
    balance: number
    currency: 'ETB'
    updatedAt: Date
}

export interface Cartela {
    id: string
    grid: number[][]
    serial: string
}

export interface Game {
    id: string
    title: string
    status: GameStatus
    ticketPrice: number
    maxPlayers: number
    currentPlayers: number
    prizePool: number
    houseEdgePct: number
    pattern: PatternType
    calledBalls: number[]
    createdAt: Date
    startedAt?: Date
    endedAt?: Date
    winnerId?: string
}

export interface Transaction {
    id: string
    userId: string
    type: TransactionType
    amount: number
    status: PaymentStatus
    referenceId?: string
    receiptUrl?: string
    note?: string
    createdAt: Date
}
