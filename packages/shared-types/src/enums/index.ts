export enum GameStatus {
    WAITING = 'WAITING',
    STARTING = 'STARTING',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    CANCELLED = 'CANCELLED',
}

export enum TransactionType {
    DEPOSIT = 'DEPOSIT',
    WITHDRAWAL = 'WITHDRAWAL',
    GAME_ENTRY = 'GAME_ENTRY',
    PRIZE_WIN = 'PRIZE_WIN',
    REFUND = 'REFUND',
}

export enum PaymentStatus {
    PENDING = 'PENDING',
    PENDING_REVIEW = 'PENDING_REVIEW',
    APPROVED = 'APPROVED',
    REJECTED = 'REJECTED',
}

export enum UserRole {
    PLAYER = 'PLAYER',
    ADMIN = 'ADMIN',
    SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum PatternType {
    ANY_LINE = 'ANY_LINE',
    DIAGONAL = 'DIAGONAL',
    FULL_CARD = 'FULL_CARD',
    X_PATTERN = 'X_PATTERN',
    CORNERS = 'CORNERS',
}
