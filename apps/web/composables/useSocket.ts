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
            // `auth` as a CALLBACK, not a literal object. Access tokens expire
            // in 15 minutes; a literal snapshots `auth.token` once, at connect
            // time, so the first reconnect after expiry re-presents that same
            // dead token and the socket silently stops authenticating — no
            // error surfaces anywhere, the player just sees support chat (and
            // every other socket feature) stop responding. The callback form
            // is re-invoked by socket.io on every reconnect attempt, so it
            // always reads the current token from the auth store. Mirrors the
            // fix already applied in apps/admin/composables/useSupportInbox.ts.
            auth: (cb: (data: { token: string | null | undefined }) => void) =>
                cb({ token: auth.token }),
            transports: ['polling', 'websocket']
        })

        socket.value.on('connect', () => {
            console.log('Socket connected:', socket.value?.id)
        })

        // Non-intrusive: this composable is shared by the whole player app
        // (games, tournaments, predictions, notifications, support chat), so
        // it must not invent new global UI for a transport-level hiccup.
        // console.warn at minimum makes a dead connection visible in devtools
        // instead of failing silently; callers that already track their own
        // error state (e.g. useSupport.ts's `support:error` listener) still
        // get their normal per-feature handling on top of this.
        socket.value.on('connect_error', (err: Error) => {
            console.warn('Socket connect_error:', err.message)
        })

        socket.value.on('disconnect', (reason: string) => {
            // 'io client disconnect' is our own teardown via disconnect(); any
            // other reason is unplanned and worth a trace.
            if (reason !== 'io client disconnect') {
                console.warn('Socket disconnected:', reason)
            }
        })

        socket.value.on('wallet:updated', (data) => {
            if (auth.wallet) {
                auth.wallet.realBalance = data.realBalance
                auth.wallet.bonusBalance = data.bonusBalance
            } else {
                auth.wallet = { realBalance: data.realBalance, bonusBalance: data.bonusBalance } as any
            }
            console.log('Wallet updated via socket:', data)
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
