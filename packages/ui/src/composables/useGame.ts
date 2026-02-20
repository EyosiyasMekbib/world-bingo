import { ref, computed } from 'vue'
import type { Socket } from 'socket.io-client'
import type { ServerToClientEvents, ClientToServerEvents } from '@world-bingo/shared-types'
import { checkPattern } from '@world-bingo/game-logic'

type BingoSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface GameCartela {
    id: string
    grid: number[][]
    serial: string
    isWinner: boolean
}

export function useGame() {
    const calledNumbers = ref<Set<number>>(new Set())
    const calledList = ref<number[]>([])
    const currentBall = ref<number | null>(null)
    const myCartelas = ref<GameCartela[]>([])
    const winnerId = ref<string | null>(null)
    const gameEnded = ref(false)

    const hasWinningPattern = computed(() =>
        myCartelas.value.some((c) =>
            checkPattern('ANY_LINE', c.grid, calledNumbers.value)
        )
    )

    function bindSocket(socket: BingoSocket, gameId: string) {
        socket.on('game:ball-called', ({ ball, calledBalls }) => {
            currentBall.value = ball
            calledNumbers.value = new Set(calledBalls)
            calledList.value = [...calledBalls]
        })

        socket.on('game:winner', ({ winner, prizeAmount }) => {
            winnerId.value = winner.id
            gameEnded.value = true
        })

        socket.on('game:ended', () => {
            gameEnded.value = true
        })
    }

    function setCartelas(cartelas: GameCartela[]) {
        myCartelas.value = cartelas.map((c) => ({ ...c, isWinner: false }))
    }

    function reset() {
        calledNumbers.value = new Set()
        calledList.value = []
        currentBall.value = null
        myCartelas.value = []
        winnerId.value = null
        gameEnded.value = false
    }

    return {
        calledNumbers,
        calledList,
        currentBall,
        myCartelas,
        winnerId,
        gameEnded,
        hasWinningPattern,
        bindSocket,
        setCartelas,
        reset,
    }
}
