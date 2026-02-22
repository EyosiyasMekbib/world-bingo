import type { Game, Cartela, User, Notification } from '../entities'

export interface ServerToClientEvents {
    'game:updated': (game: Game) => void
    'game:ball-called': (payload: { gameId: string; ball: number; calledBalls: number[] }) => void
    'game:winner': (payload: { gameId: string; winner: User; prizeAmount: number }) => void
    'game:started': (game: Game) => void
    'game:ended': (game: Game) => void
    'game:cancelled': (payload: { gameId: string; reason: string }) => void
    'lobby:game-added': (game: Game) => void
    'lobby:game-removed': (gameId: string) => void
    'cartela:marked': (payload: { cartelaId: string; cell: [number, number] }) => void
    'wallet:updated': (payload: { balance: number }) => void
    'notification:new': (notification: Notification) => void
    error: (payload: { message: string; code: string }) => void
}

export interface ClientToServerEvents {
    'game:join': (payload: { gameId: string; cartelaId: string }) => void
    'game:join-room': (payload: { gameId: string }) => void
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

