import { io, Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@world-bingo/shared-types'

export const useSocket = () => {
    const config = useRuntimeConfig()
    const auth = useAuth()
    
    // Singleton socket? Or per component?
    // composable is reactive context but instance should be managed carefully.
    // For Nuxt, we can use useState to keep the socket instance or just a raw singleton module scope if careful.
    
    const socket = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>('socket', () => null)

    // The user the live socket was BUILT for. The server binds
    // `socket.data.userId` once, at handshake, and never revalidates it, so a
    // socket built while player A was signed in keeps acting as A after B
    // signs in on the same device. Reusing it on identity alone (rather than
    // on the token string) is deliberate: a rotated token is presented on the
    // next reconnect by the auth callback below, and rebuilding the socket on
    // every rotation would drop every game and lobby room the app holds.
    const socketUserId = useState<string | null>('socket_user_id', () => null)

    // True once a refresh came back null — the refresh token is gone or
    // rejected, and no amount of reconnecting will fix it. Features that need
    // an authenticated socket read this to say so instead of spinning.
    const signedOut = useState('socket_signed_out', () => false)
    
    const connect = () => {
        const identity = auth.user?.id ?? null

        // `connected` alone was not enough, twice over.
        //
        // `active` covers the handshake window: a socket mid-connect is
        // neither connected nor dead, and the old check fell through to the
        // disconnect() below — so a second caller during the handshake tore
        // down the socket the first caller was still opening, for EVERY
        // feature in the app rather than just the one that called.
        //
        // The identity comparison covers the other direction: a socket that is
        // genuinely connected but was built for a different user is worse than
        // no socket, because it looks healthy while acting as somebody else.
        if (socket.value && (socket.value.connected || socket.value.active) && socketUserId.value === identity) {
            return socket.value
        }

        // A disconnected socket is not a dead socket — socket.io keeps retrying
        // it in the background. Replacing `socket.value` without tearing the old
        // one down left a zombie alive with every listener still attached, so
        // once it reconnected each event was handled twice against the same
        // shared state: support:message appended every reply to the transcript
        // twice and double-counted the unread badge, and wallet:updated fired
        // two writes per update. Callers already re-bind onto whatever instance
        // this returns, so the old one has no work left to do.
        socket.value?.disconnect()
        socketUserId.value = identity

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
            //
            // The callback is also where the token gets REFRESHED, rather than
            // in connect() itself. socket.io waits for `cb` before sending the
            // CONNECT packet, so an await here is free — and unlike an async
            // connect() it covers every reconnect attempt, not just the first
            // one, without turning this function's return value into a promise
            // that eight other call sites would have to await.
            auth: async (cb: (data: { token: string | null | undefined }) => void) => {
                if (auth.isAuthenticated) {
                    try {
                        // Shares the store's single-flight refresh (and its
                        // margin), so a reconnect during a page load no longer
                        // races the page's own calls with a second refresh —
                        // which is how one of them used to lose and log the
                        // player out. It also no-ops when the token is healthy.
                        await auth.ensureFreshToken()
                        signedOut.value = !auth.token
                    } catch {
                        // Transient (dropped connection, 429, 5xx). The store
                        // kept the session, so connect with the token we have
                        // and let the server judge it; only a definitive
                        // refusal clears `auth.token`.
                        signedOut.value = false
                    }
                }

                cb({ token: auth.token })
            },
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
            socketUserId.value = null
        }
    }
    
    return {
        socket,
        signedOut,
        connect,
        disconnect
    }
}
