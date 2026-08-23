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

    socket.value = io(config.public.wsUrl as string, {
      auth: { token: accessToken.value },
      transports: ['polling', 'websocket'],
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

    socket.value.on('support:queue-update', (payload: { unassignedCount: number }) => {
      unassignedCount.value = payload.unassignedCount
      refreshQueue()
    })

    socket.value.on('support:error', (payload: { message: string }) => {
      error.value = payload.message
    })
  }

  const setFilter = async (next: typeof filter.value) => {
    filter.value = next
    await refreshQueue()
  }

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
    watch: watchThread,
    claim,
    release,
    resolve,
    reply,
    refreshQueue,
  }
}
