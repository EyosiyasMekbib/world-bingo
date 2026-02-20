import { ref, onMounted, onUnmounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import type { ServerToClientEvents, ClientToServerEvents } from '@world-bingo/shared-types'

type BingoSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export function useSocket(url: string) {
    const socket = ref<BingoSocket | null>(null)
    const connected = ref(false)

    onMounted(() => {
        socket.value = io(url, {
            autoConnect: true,
            withCredentials: true,
        }) as BingoSocket

        socket.value.on('connect', () => {
            connected.value = true
        })

        socket.value.on('disconnect', () => {
            connected.value = false
        })
    })

    onUnmounted(() => {
        socket.value?.disconnect()
    })

    return { socket, connected }
}
