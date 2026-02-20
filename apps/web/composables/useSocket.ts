import { io, Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@world-bingo/shared-types'

export const useSocket = () => {
    const config = useRuntimeConfig()
    const auth = useAuth()
    
    // Singleton socket? Or per component?
    // composable is reactive context but instance should be managed carefully.
    // For Nuxt, we can use useState to keep the socket instance or just a raw singleton module scope if careful.
    
    const socket = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>('socket', () => null)
    
    const connect = () => {
        if (socket.value?.connected) return socket.value
        
        socket.value = io(config.public.wsUrl, {
            auth: {
                token: auth.token
            },
            transports: ['websocket']
        })
        
        socket.value.on('connect', () => {
            console.log('Socket connected:', socket.value?.id)
        })
        
        return socket.value
    }
    
    const disconnect = () => {
        if (socket.value) {
            socket.value.disconnect()
            socket.value = null
        }
    }
    
    return {
        socket,
        connect,
        disconnect
    }
}
