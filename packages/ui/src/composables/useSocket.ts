import { ref, shallowRef, onMounted, onUnmounted, type Ref, type ShallowRef } from 'vue'
import { io, type Socket } from 'socket.io-client'
import type { ServerToClientEvents, ClientToServerEvents } from '@world-bingo/shared-types'

type BingoSocket = Socket<ServerToClientEvents, ClientToServerEvents>

// Explicit return type: without it, TS tries to inline socket.io-client's deep
// internal types (engine.io Cookie/HandshakeData/…) into the inferred type and
// fails with TS2742/TS4058 ("cannot be named") under declaration checking.
// shallowRef (not ref) keeps the Socket class instance un-unwrapped — Vue should
// not deep-reactify a socket, and deep UnwrapRef mangles the Socket type.
export function useSocket(url: string): {
    socket: ShallowRef<BingoSocket | null>
    connected: Ref<boolean>
} {
    const socket = shallowRef<BingoSocket | null>(null)
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
