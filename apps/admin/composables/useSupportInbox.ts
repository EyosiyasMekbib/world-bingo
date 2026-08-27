import { io, type Socket } from 'socket.io-client'
import type {
  SupportConversation,
  SupportConversationWithMessages,
  SupportMessage,
  SupportQueueItem,
} from '@world-bingo/shared-types'

export const useSupportInbox = () => {
  const { accessToken } = useAdminAuth()
  const api = useAdminApi()
  const config = useRuntimeConfig()

  const socket = useState<Socket | null>('support_admin_socket', () => null)
  const queue = useState<SupportQueueItem[]>('support_queue', () => [])
  const filter = useState<'unassigned' | 'mine' | 'all' | 'resolved'>(
    'support_filter',
    () => 'unassigned',
  )
  const active = useState<SupportConversation | null>('support_active', () => null)
  const messages = useState<SupportMessage[]>('support_active_messages', () => [])
  const unassignedCount = useState('support_unassigned_count', () => 0)
  const error = useState<string | null>('support_admin_error', () => null)

  const refreshQueue = async () => {
    try {
      queue.value = await api.getSupportQueue(filter.value)
    } catch (e: any) {
      error.value = e?.data?.error ?? 'Could not load the queue'
    }
  }

  const connectInbox = async () => {
    await refreshQueue()
    if (socket.value?.connected) return

    // A disconnected socket is not a dead socket — socket.io keeps retrying it
    // in the background. Overwriting the ref without tearing the old one down
    // left it alive with a full set of listeners, so as soon as it came back
    // every support:message was handled twice: each reply appended to the
    // transcript twice, and two refreshQueue() round-trips per event.
    socket.value?.disconnect()

    // `auth` as a CALLBACK, not a literal. Admin access tokens expire in 15
    // minutes; a literal snapshots the token at connect time, so the first
    // reconnect after expiry re-presents a dead token and the socket drops out
    // silently — the clerk keeps staring at a queue that stopped updating.
    // The callback form is re-invoked on every reconnect attempt.
    socket.value = io(config.public.wsUrl as string, {
      auth: (cb: (data: { token: string | null | undefined }) => void) =>
        cb({ token: accessToken.value }),
      transports: ['polling', 'websocket'],
    })

    // A silently dead socket is the failure mode that actually hurts here, so
    // surface it rather than letting the queue quietly freeze.
    socket.value.on('connect_error', (err: Error) => {
      error.value = `Live updates disconnected (${err.message}). Reload if the queue looks stale.`
    })

    socket.value.on('disconnect', (reason: string) => {
      // 'io client disconnect' is our own teardown; anything else is unplanned.
      if (reason !== 'io client disconnect') {
        error.value = 'Live updates disconnected. Reconnecting…'
      }
    })

    socket.value.on('connect', () => {
      error.value = null
      refreshQueue()
      // Socket.io rooms do not survive a reconnect: the server builds a fresh
      // Socket with a new id, belonging to no room until it joins one again.
      // `support:conv:<id>` is only ever joined by the support:watch handler,
      // so after any transport drop the clerk's open thread went silent — new
      // player messages stopped arriving, and so did the echo of the clerk's
      // own replies, while the queue beside it kept refreshing and looking
      // healthy. Re-watching rejoins the room and reloads the transcript,
      // which also backfills anything said while the socket was down.
      if (active.value) watchThread(active.value.id)
    })

    socket.value.on('support:thread', (payload: SupportConversationWithMessages) => {
      active.value = payload.conversation
      messages.value = payload.messages
    })

    socket.value.on('support:message', (message: SupportMessage) => {
      if (message.conversationId === active.value?.id) {
        messages.value = [...messages.value, message]
      }
      // A message on any thread reorders the list and changes previews.
      refreshQueue()
    })

    socket.value.on('support:status', (conversation: SupportConversation) => {
      if (conversation.id === active.value?.id) active.value = conversation
      refreshQueue()
    })

    // Payload types come from shared-types. Hand-typing a narrower shape here
    // silently drops fields — an inlined `{ message: string }` for support:error
    // discards `code`, so nothing downstream can ever tell a rate-limit from a
    // permission denial.
    socket.value.on(
      'support:queue-update',
      (payload: { conversationId: string; unassignedCount: number }) => {
        unassignedCount.value = payload.unassignedCount
        refreshQueue()
      },
    )

    socket.value.on(
      'support:error',
      (payload: { conversationId?: string; code: string; message: string }) => {
        error.value = payload.message
      },
    )
  }

  const setFilter = async (next: typeof filter.value) => {
    filter.value = next
    await refreshQueue()
  }

  // Named watchThread, and returned under that exact name. Returning it as
  // `watch` would let a page destructure `watch` and shadow Vue's auto-imported
  // `watch()`, silently breaking every watcher in that component.
  const watchThread = (conversationId: string) => {
    error.value = null
    socket.value?.emit('support:watch', { conversationId })
  }

  const claim = (conversationId: string) => socket.value?.emit('support:claim', { conversationId })
  const release = (conversationId: string) =>
    socket.value?.emit('support:release', { conversationId })
  const resolve = (conversationId: string) =>
    socket.value?.emit('support:resolve', { conversationId })

  const reply = (body: string) => {
    const trimmed = body.trim()
    if (!trimmed || !active.value) return
    socket.value?.emit('support:send', { conversationId: active.value.id, body: trimmed })
  }

  return {
    queue,
    filter,
    active,
    messages,
    unassignedCount,
    error,
    connectInbox,
    setFilter,
    watchThread,
    claim,
    release,
    resolve,
    reply,
    refreshQueue,
  }
}
