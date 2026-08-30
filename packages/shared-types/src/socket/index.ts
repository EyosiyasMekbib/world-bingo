import type { Game, Cartela, User, Notification } from '../entities'
import type {
    SupportConversation,
    SupportConversationWithMessages,
    SupportMessage,
    SupportContactInfo,
    SupportQueueItem,
} from '../entities/support'

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
    'cartelas:taken': (payload: { gameId: string; cartelaSerials: string[] }) => void
    'cartela:marked': (payload: { cartelaId: string; cell: [number, number] }) => void
    'wallet:updated': (payload: { realBalance: number; bonusBalance: number }) => void
    'notification:new': (notification: Notification) => void
    'jackpot:update': (payload: { amount: number }) => void
    'jackpot:won': (payload: { winnerId: string; amount: number }) => void
    'tournament:updated': (payload: { tournamentId: string; status: string; currentPlayers: number; prizePool: number }) => void
    'tournament:round-started': (payload: { tournamentId: string; round: number; gameId: string }) => void
    'tournament:eliminated': (payload: { tournamentId: string; userId: string }) => void
    'tournament:winner': (payload: { tournamentId: string; winnerId: string; username: string; prizeAmount: number }) => void

    // ── Support Chat ─────────────────────────────────────────────────────────
    /** The live thread, sent in reply to support:open */
    'support:thread': (payload: SupportConversationWithMessages) => void
    /** A persisted message on a thread the socket is subscribed to */
    'support:message': (message: SupportMessage) => void
    /** Status or assignment changed */
    'support:status': (conversation: SupportConversation) => void
    /** Queue changed — emitted to the support:agents room only. `item` carries
     *  the row that changed so the inbox can patch it in place instead of
     *  refetching the whole queue on every message. */
    'support:queue-update': (payload: {
        conversationId: string
        unassignedCount: number
        item?: SupportQueueItem
    }) => void
    /** Real phone/Telegram contact, pushed when no agent is online */
    'support:contact-fallback': (payload: { conversationId: string } & SupportContactInfo) => void
    'support:error': (payload: { conversationId?: string; code: string; message: string }) => void

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

    // ── Support Chat ─────────────────────────────────────────────────────────
    /** Fetch or create the caller's live thread */
    'support:open': () => void
    /**
     * Send a message. The trailing `ack` is how the sender learns the message
     * actually persisted: without it the client can only ever hope, and a send
     * that dies in the rate limiter, the attachment check or the catch block
     * looks identical to one still in flight. `clientMsgId` is generated by
     * the sender, echoed on the broadcast, and used to replace the optimistic
     * bubble rather than append a second copy of it.
     */
    'support:send': (
        payload: {
            conversationId: string
            clientMsgId: string
            body: string
            attachmentUrl?: string
            attachmentMime?: string
        },
        ack?: (
            result:
                | { ok: true; message: SupportMessage }
                | { ok: false; code: string; message: string },
        ) => void,
    ) => void
    'support:escalate': (payload: { conversationId: string }) => void
    /** Staff only */
    'support:claim': (payload: { conversationId: string }) => void
    'support:release': (payload: { conversationId: string }) => void
    'support:resolve': (payload: { conversationId: string }) => void
    /** Staff subscribes to a specific thread to watch it */
    'support:watch': (payload: { conversationId: string }) => void
    /** Staff stops watching a thread — leaves the room so a clerk who has
     *  clicked through twenty threads is not still receiving all twenty. */
    'support:unwatch': (payload: { conversationId: string }) => void
    'support:read': (payload: { conversationId: string }) => void
}

export interface InterServerEvents {
    ping: () => void
}

export interface SocketData {
    userId: string
    username: string
    gameId?: string
    /** Role from the JWT claims. The support gateway authorizes staff events off this. */
    role?: string
}

export interface TypedSocket {
    on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void
    emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): void
    off<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): void
}

export type { Cartela }
