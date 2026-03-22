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
            transports: ['polling', 'websocket']
        })
        
        socket.value.on('connect', () => {
            console.log('Socket connected:', socket.value?.id)
        })

        socket.value.on('wallet:updated', (data) => {
            if (auth.wallet) {
                auth.wallet.balance = data.balance
            } else {
                // If wallet for some reason is null, create a minimal object
                auth.wallet = { balance: data.balance } as any
            }
            console.log('Wallet updated via socket:', data.balance)
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
