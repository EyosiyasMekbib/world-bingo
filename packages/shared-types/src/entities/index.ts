import type { GameStatus, UserRole, PatternType, TransactionType, PaymentStatus, NotificationType } from '../enums'

export interface User {
    id: string
    serial: number
    username?: string
    phone?: string
    email?: string
    role: UserRole
    avatarUrl?: string
    telegramId?: string
    telegramUsername?: string
    firstName?: string
    lastName?: string
    photoUrl?: string
    createdAt: Date
    updatedAt: Date
}

export interface UserStatsDto {
    gamesPlayed: number
    gamesWon: number
    totalWagered: number
    totalWon: number
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
    minPlayers: number
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
    balanceBefore?: number
    balanceAfter?: number
    createdAt: Date
}

export interface Notification {
    id: string
    userId: string
    type: NotificationType
    title: string
    body: string
    isRead: boolean
    metadata?: Record<string, unknown>
    createdAt: Date
}

export interface GameTemplate {
    id: string
    title: string
    ticketPrice: number
    maxPlayers: number
    minPlayers: number
    houseEdgePct: number
    pattern: PatternType
    active: boolean
    countdownSecs: number
    botEnabled?: boolean
    botCount?: number
    botFillToMin?: boolean
    createdAt: Date
    updatedAt: Date
}

