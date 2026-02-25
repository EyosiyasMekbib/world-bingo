import { defineStore } from 'pinia'
import type { Game, Cartela } from '@world-bingo/shared-types'
import { useAuthStore } from './auth'

interface GameEntry {
    id: string
    cartelaId: string
    cartela: Cartela
}

interface GameState {
    availableGames: Game[]
    currentGame: Game | null
    calledBalls: number[]
    myEntries: GameEntry[]
    availableCartelas: Cartela[]
    gameStatus: 'idle' | 'joining' | 'waiting' | 'starting' | 'active' | 'ended'
    winner: { username: string; prizeAmount: number } | null
    error: string | null
    loadingGames: boolean
    loadingGame: boolean
    /** Countdown timers for games that reached minPlayers — gameId → startsAt ISO string */
    countdowns: Record<string, string>
}

export const useGameStore = defineStore('game', {
    state: (): GameState => ({
        availableGames: [],
        currentGame: null,
        calledBalls: [],
        myEntries: [],
        availableCartelas: [],
        gameStatus: 'idle',
        winner: null,
        error: null,
        loadingGames: false,
        loadingGame: false,
        countdowns: {},
    }),

    getters: {
        lastCalledBall: (state) => state.calledBalls[state.calledBalls.length - 1] ?? null,
        hasJoined: (state) => state.myEntries.length > 0,
        currentGameId: (state) => state.currentGame?.id ?? null,
    },

    actions: {
        async fetchAvailableGames() {
            const config = useRuntimeConfig()
            this.loadingGames = true
            this.error = null
            try {
                const games = await $fetch<Game[]>(`${config.public.apiBase}/games`)
                this.availableGames = games
            } catch (e: any) {
                this.error = e?.message ?? 'Failed to load games'
            } finally {
                this.loadingGames = false
            }
        },

        async fetchGameDetails(gameId: string) {
            const config = useRuntimeConfig()
            this.loadingGame = true
            this.error = null
            try {
                const game = await $fetch<Game>(`${config.public.apiBase}/games/${gameId}`)
                this.currentGame = game
                this.calledBalls = (game as any).calledBalls ?? []
                return game
            } catch (e: any) {
                this.error = e?.message ?? 'Failed to load game'
                return null
            } finally {
                this.loadingGame = false
            }
        },

        async fetchAvailableCartelas(gameId: string) {
            const config = useRuntimeConfig()
            try {
                const cartelas = await $fetch<any[]>(`${config.public.apiBase}/games/${gameId}/cartelas`)
                this.availableCartelas = cartelas.filter((c) => !c.isTaken)
            } catch (e: any) {
                this.error = e?.message ?? 'Failed to load cartelas'
            }
        },

        async joinGame(gameId: string, cartelaSerials: string[]) {
            const auth = useAuthStore()
            this.gameStatus = 'joining'
            this.error = null
            try {
                const entries = await auth.apiFetch<GameEntry[]>(`/games/${gameId}/join`, {
                    method: 'POST',
                    body: { gameId, cartelaSerials },
                })
                this.myEntries = entries
                this.gameStatus = 'waiting'
                return entries
            } catch (e: any) {
                this.error = e?.message ?? 'Failed to join game'
                this.gameStatus = 'idle'
                throw e
            }
        },

        async claimBingo(gameId: string, cartelaId: string) {
            const auth = useAuthStore()
            this.error = null
            try {
                return await auth.apiFetch(`/games/${gameId}/claim`, {
                    method: 'POST',
                    body: { gameId, cartelaId },
                })
            } catch (e: any) {
                this.error = e?.message ?? 'Bingo claim failed'
                throw e
            }
        },

        // ── Socket event handlers ─────────────────────────────────────────────

        onGameUpdated(game: Game) {
            this.currentGame = game
            const idx = this.availableGames.findIndex((g) => g.id === game.id)
            if (idx !== -1) {
                this.availableGames[idx] = game
            }
        },

        onGameStarted(game: Game) {
            this.currentGame = game
            this.gameStatus = 'starting'
        },

        onBallCalled(payload: { gameId: string; ball: number; calledBalls: number[] }) {
            if (this.currentGame?.id === payload.gameId) {
                this.calledBalls = payload.calledBalls
                this.gameStatus = 'active'
            }
        },

        onGameWinner(payload: { gameId: string; winner: any; prizeAmount: number }) {
            if (this.currentGame?.id === payload.gameId) {
                this.winner = {
                    username: payload.winner?.username ?? 'Unknown',
                    prizeAmount: payload.prizeAmount,
                }
                this.gameStatus = 'ended'
            }
        },

        onGameEnded(game: Game) {
            if (this.currentGame?.id === game.id) {
                this.currentGame = game
                this.gameStatus = 'ended'
            }
        },

        onGameCancelled(payload: { gameId: string; reason: string }) {
            if (this.currentGame?.id === payload.gameId) {
                this.gameStatus = 'ended'
            }
            this.availableGames = this.availableGames.filter((g) => g.id !== payload.gameId)
        },

        onLobbyGameAdded(game: Game) {
            const exists = this.availableGames.some((g) => g.id === game.id)
            if (!exists) {
                this.availableGames.unshift(game)
            }
        },

        onLobbyGameRemoved(gameId: string) {
            this.availableGames = this.availableGames.filter((g) => g.id !== gameId)
            delete this.countdowns[gameId]
        },

        onGameCountdown(payload: { gameId: string; countdownSecs: number; startsAt: string }) {
            this.countdowns[payload.gameId] = payload.startsAt
        },

        resetGame() {
            this.currentGame = null
            this.calledBalls = []
            this.myEntries = []
            this.availableCartelas = []
            this.gameStatus = 'idle'
            this.winner = null
            this.error = null
        },
    },
})
