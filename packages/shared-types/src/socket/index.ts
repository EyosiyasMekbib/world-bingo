import type { Game, Cartela, User, Notification } from '../entities'

export interface ServerToClientEvents {
    // ── Lobby ────────────────────────────────────────────────────────────────
    'lobby:game-added': (game: Game) => void
    'lobby:game-removed': (gameId: string) => void

    // ── Room / Waiting Phase ─────────────────────────────────────────────────
    /** Per-second countdown tick while the room is in WAITING state */
    'timer_update': (payload: { gameId: string; secondsLeft: number }) => void
    /** Fires whenever a player joins the room */
    'player_count_update': (payload: { gameId: string; playerCount: number }) => void
    /** Fires whenever a ticket is purchased, reflecting the new pot total */
    'pot_update': (payload: { gameId: string; pot: number }) => void

    // ── Game Loop ─────────────────────────────────────────────────────────────
    /** A new number has been drawn (every 3 s during IN_PROGRESS) */
    'new_call': (payload: { gameId: string; ball: number; calledBalls: number[] }) => void
    /** Alias for new_call kept for back-compat */
    'game:ball-called': (payload: { gameId: string; ball: number; calledBalls: number[] }) => void

    // ── Resolution ────────────────────────────────────────────────────────────
    /** Game ended with winners — includes payout breakdown */
    'game_over': (payload: {
        gameId: string
        winners: Array<{ userId: string; username: string; netWin: number }>
        houseFee: number
        totalPot: number
    }) => void
    /** Game cancelled (under-fill refund path) */
    'game_cancelled': (payload: { gameId: string; reason: string }) => void

    // ── Legacy aliases (kept for existing clients) ────────────────────────────
    'game:updated': (game: Game) => void
    'game:winner': (payload: { gameId: string; winner: User; prizeAmount: number }) => void
    'game:started': (game: Game) => void
    'game:ended': (game: Game) => void
    'game:cancelled': (payload: { gameId: string; reason: string }) => void
    'game:countdown': (payload: { gameId: string; countdownSecs: number; startsAt: string }) => void
    'cartela:marked': (payload: { cartelaId: string; cell: [number, number] }) => void
    'wallet:updated': (payload: { balance: number }) => void
    'notification:new': (notification: Notification) => void
    'jackpot:update': (payload: { amount: number }) => void
    'jackpot:won': (payload: { winnerId: string; amount: number }) => void
    'tournament:updated': (payload: { tournamentId: string; status: string; currentPlayers: number; prizePool: number }) => void
    'tournament:round-started': (payload: { tournamentId: string; round: number; gameId: string }) => void
    'tournament:eliminated': (payload: { tournamentId: string; userId: string }) => void
    'tournament:winner': (payload: { tournamentId: string; winnerId: string; username: string; prizeAmount: number }) => void
    error: (payload: { message: string; code: string }) => void
}

export interface ClientToServerEvents {
    /** Join a game room (spectator / pre-joined via REST) */
    'game:join-room': (payload: { gameId: string }) => void
    /** Purchase tickets in the WAITING phase */
    'buy_tickets': (payload: { gameId: string; cartelaIds: string[] }) => void
    /** Legacy single-cartela join (kept for back-compat) */
    'game:join': (payload: { gameId: string; cartelaId: string }) => void
    'game:leave': (payload: { gameId: string }) => void
    'game:claim-bingo': (payload: { gameId: string; cartelaId: string }) => void
    'lobby:subscribe': () => void
    'lobby:unsubscribe': () => void
    'notification:mark-read': (payload: { notificationId: string }) => void
}

export interface InterServerEvents {
    ping: () => void
}

export interface SocketData {
    userId: string
    username: string
    gameId?: string
}

export interface TypedSocket {
    on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void
    emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): void
    off<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void
}

export type { Cartela }
