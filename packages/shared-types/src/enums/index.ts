export enum GameStatus {
    WAITING = 'WAITING',
    STARTING = 'STARTING',
    LOCKING = 'LOCKING',
    IN_PROGRESS = 'IN_PROGRESS',
    PAYOUT = 'PAYOUT',
    REFUNDING = 'REFUNDING',
    COMPLETED = 'COMPLETED',
    CANCELLED = 'CANCELLED',
}

export enum TransactionType {
    DEPOSIT = 'DEPOSIT',
    WITHDRAWAL = 'WITHDRAWAL',
    GAME_ENTRY = 'GAME_ENTRY',
    PRIZE_WIN = 'PRIZE_WIN',
    REFUND = 'REFUND',
    FIRST_DEPOSIT_BONUS = 'FIRST_DEPOSIT_BONUS',
    CASHBACK_BONUS = 'CASHBACK_BONUS',
    ADMIN_REAL_ADJUSTMENT = 'ADMIN_REAL_ADJUSTMENT',
    ADMIN_BONUS_ADJUSTMENT = 'ADMIN_BONUS_ADJUSTMENT',
    TP_BET = 'TP_BET',
    TP_WIN = 'TP_WIN',
    TP_ROLLBACK = 'TP_ROLLBACK',
    TP_ADJUSTMENT = 'TP_ADJUSTMENT',
    CAMPAIGN_BONUS = 'CAMPAIGN_BONUS',
    DAILY_DEPOSIT_BONUS = 'DAILY_DEPOSIT_BONUS',
    WEEKLY_DEPOSIT_BONUS = 'WEEKLY_DEPOSIT_BONUS',
    BONUS_EXPIRED = 'BONUS_EXPIRED',
}

export enum GameProviderStatus {
    ACTIVE = 'ACTIVE',
    INACTIVE = 'INACTIVE',
    MAINTENANCE = 'MAINTENANCE',
}

export enum ThirdPartyTxType {
    BET = 'BET',
    BET_RESULT = 'BET_RESULT',
    BET_DEBIT = 'BET_DEBIT',
    BET_CREDIT = 'BET_CREDIT',
    ROLLBACK = 'ROLLBACK',
    ADJUSTMENT = 'ADJUSTMENT',
}

export enum ThirdPartyTxStatus {
    COMPLETED = 'COMPLETED',
    ROLLED_BACK = 'ROLLED_BACK',
    FAILED = 'FAILED',
}

export enum PaymentStatus {
    PENDING = 'PENDING',
    PENDING_REVIEW = 'PENDING_REVIEW',
    APPROVED = 'APPROVED',
    REJECTED = 'REJECTED',
}

export enum UserRole {
    PLAYER = 'PLAYER',
    CLERK = 'CLERK',
    AGENT = 'AGENT',
    ADMIN = 'ADMIN',
    SUPER_ADMIN = 'SUPER_ADMIN',
}

/** Movements in and out of a cash agent's prepaid float. Mirrors
 *  AgentLedgerType in apps/api/prisma/schema.prisma - change both together. */
export enum AgentLedgerType {
    TOP_UP = 'TOP_UP',
    COMMISSION = 'COMMISSION',
    FULFILLMENT = 'FULFILLMENT',
    ADJUSTMENT = 'ADJUSTMENT',
}

/** Lifecycle of a player's request to pay cash at an agent. Mirrors
 *  AgentDepositRequestStatus in apps/api/prisma/schema.prisma - change both together. */
export enum AgentDepositRequestStatus {
    PENDING = 'PENDING',
    FULFILLED = 'FULFILLED',
    EXPIRED = 'EXPIRED',
    CANCELLED = 'CANCELLED',
}

export enum PatternType {
    ANY_LINE = 'ANY_LINE',
    DIAGONAL = 'DIAGONAL',
    FULL_CARD = 'FULL_CARD',
    X_PATTERN = 'X_PATTERN',
    CORNERS = 'CORNERS',
}

export enum NotificationType {
    GAME_CANCELLED = 'GAME_CANCELLED',
    REFUND_PROCESSED = 'REFUND_PROCESSED',
    DEPOSIT_APPROVED = 'DEPOSIT_APPROVED',
    DEPOSIT_REJECTED = 'DEPOSIT_REJECTED',
    WITHDRAWAL_PROCESSED = 'WITHDRAWAL_PROCESSED',
    GAME_WON = 'GAME_WON',
    GAME_STARTING = 'GAME_STARTING',
    REFERRAL_BONUS = 'REFERRAL_BONUS',
    TOURNAMENT_STARTING = 'TOURNAMENT_STARTING',
    TOURNAMENT_WON = 'TOURNAMENT_WON',
    TOURNAMENT_ELIMINATED = 'TOURNAMENT_ELIMINATED',
    CASHBACK_AWARDED = 'CASHBACK_AWARDED',
    CAMPAIGN_MESSAGE = 'CAMPAIGN_MESSAGE',
    SUPPORT_REPLY = 'SUPPORT_REPLY',
    ACCOUNT_STATUS_CHANGED = 'ACCOUNT_STATUS_CHANGED',
    BONUS_GRANTED = 'BONUS_GRANTED',
    BONUS_EXPIRING = 'BONUS_EXPIRING',
}

export enum TournamentStatus {
    REGISTRATION = 'REGISTRATION',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    CANCELLED = 'CANCELLED',
}

export enum CashbackRefundType {
    PERCENTAGE = 'PERCENTAGE',
    FIXED = 'FIXED',
}

export enum CashbackFrequency {
    DAILY = 'DAILY',
    WEEKLY = 'WEEKLY',
    MONTHLY = 'MONTHLY',
}

/**
 * When a cashback promotion actually pays out.
 *
 * PERIOD_CLOSE waits for the day/week/month to end and pays the accrued total
 * once, which is the cheapest to reason about and the only behaviour that
 * existed before this enum. ON_THRESHOLD pays as soon as the accrual crosses
 * the promotion's minimum, so a player who loses early does not wait out the
 * rest of the period to see anything back.
 */
export enum CashbackPayoutTiming {
    PERIOD_CLOSE = 'PERIOD_CLOSE',
    ON_THRESHOLD = 'ON_THRESHOLD',
}

export enum BonusRuleType {
    DAILY_DEPOSIT = 'DAILY_DEPOSIT',
    WEEKLY_DEPOSIT = 'WEEKLY_DEPOSIT',
}

export enum BonusRewardType {
    FIXED = 'FIXED',
    PERCENTAGE = 'PERCENTAGE',
}

export enum BonusGrantStatus {
    ACTIVE = 'ACTIVE',
    CONSUMED = 'CONSUMED',
    EXPIRED = 'EXPIRED',
}

/**
 * Why a bonus grant exists. TransactionType already records the ledger entry,
 * but a grant outlives its credit -- it expires, gets consumed, gets reported
 * on -- so the reason has to live on the grant itself rather than be re-derived
 * from the transaction each time.
 *
 * REFUND is the reversal case: bonus money handed back when a game a player
 * entered with bonus funds is cancelled.
 */
export enum BonusSource {
    FIRST_DEPOSIT = 'FIRST_DEPOSIT',
    DAILY_DEPOSIT = 'DAILY_DEPOSIT',
    WEEKLY_DEPOSIT = 'WEEKLY_DEPOSIT',
    CASHBACK = 'CASHBACK',
    CAMPAIGN = 'CAMPAIGN',
    ADMIN = 'ADMIN',
    REFUND = 'REFUND',
}

/**
 * The kind of promotion a public promo tile stands for. This is a presentation
 * grouping, not a storage one: WELCOME and REFERRAL are site settings with no
 * row of their own, while CASHBACK and DEPOSIT_RULE point at a
 * CashbackPromotion or a BonusRule. PromoArtwork keys off this plus a refId so
 * all four can carry admin-uploaded art through one table.
 */
export enum PromoKind {
    WELCOME = 'WELCOME',
    CASHBACK = 'CASHBACK',
    DEPOSIT_RULE = 'DEPOSIT_RULE',
    REFERRAL = 'REFERRAL',
}

export enum SpendAccount {
    REAL = 'REAL',
    BONUS = 'BONUS',
}

/**
 * Whether an account may act. Covers staff as well as players.
 *
 * RESTRICTED is the investigation state: the player can still log in, see their
 * balance and reach support, but cannot move money or join a game. It exists so
 * that containment does not make someone unreachable exactly when you need them
 * to explain themselves.
 */
export enum AccountStatus {
    ACTIVE = 'ACTIVE',
    RESTRICTED = 'RESTRICTED',
    SUSPENDED = 'SUSPENDED',
}

/**
 * Why a reviewer rejected a manual deposit. Stored on
 * Transaction.rejectionReason and sent as `reason` on `deposit_rejected`.
 * OTHER must carry a note. Mirrors `enum DepositRejectionReason` in
 * apps/api/prisma/schema.prisma — change both together.
 */
export enum DepositRejectionReason {
    DUPLICATE_RECEIPT = 'DUPLICATE_RECEIPT',
    AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
    PAYER_MISMATCH = 'PAYER_MISMATCH',
    UNREADABLE_RECEIPT = 'UNREADABLE_RECEIPT',
    NOT_FOUND = 'NOT_FOUND',
    OTHER = 'OTHER',
}
