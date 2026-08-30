import { io, type Socket } from 'socket.io-client'
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SupportConversation,
  SupportConversationWithMessages,
  SupportMessage,
  SupportQueueItem,
} from '@world-bingo/shared-types'

/**
 * A transcript row that may not exist on the server yet. `pending` is the
 * optimistic bubble a reply renders as between the emit and the ack; `failed`
 * is one the gateway refused, or one that was never acknowledged at all.
 * Both are local-only markers — nothing on the wire carries them.
 */
export type InboxMessage = SupportMessage & { pending?: boolean; failed?: boolean }

/**
 * The ack payload, read straight off the socket contract rather than
 * hand-written here. A narrower local copy would silently drop whatever the
 * gateway adds to it later — the same trap the support:error listener below
 * is commented for.
 */
type SendAck = Parameters<NonNullable<Parameters<ClientToServerEvents['support:send']>[1]>>[0]
type QueueUpdate = Parameters<ServerToClientEvents['support:queue-update']>[0]

/**
 * Trailing debounce on the queue read. Six clerks behind one office NAT share
 * a single 100-requests-per-minute IP budget, and a busy shift used to spend
 * it on one /admin/support/queue round trip per message per clerk. 400ms is
 * below the threshold where a clerk notices the list settling and far above
 * the burst rate of a conversation.
 */
const QUEUE_REFRESH_DEBOUNCE_MS = 400

/**
 * How long after `connect` we wait before believing the connection. See the
 * connect handler: the transport coming up is not proof the socket is
 * authenticated, and the server's objection arrives just after the handshake.
 */
const CONNECT_LIVENESS_MS = 2_000

/**
 * Admin access tokens live 15 minutes. apiFetch refreshes reactively off a
 * 401, but an inbox that is merely being watched makes no HTTP request at
 * all, so nothing ever triggers that path and the cookie goes stale under a
 * clerk who is doing exactly what the page is for. Refresh on a timer while
 * the inbox is mounted so the socket's auth callback always has something
 * live to present on its next reconnect.
 */
const TOKEN_REFRESH_MS = 10 * 60_000

/**
 * An ack that never comes. Deliberately not a retry: `clientMsgId` is not
 * persisted server-side, so a resend is a second row rather than an
 * idempotent replay, and a timeout does not prove the message was lost — only
 * that we did not hear back. The bubble goes to `failed` and the clerk, who
 * can see the transcript, decides.
 */
const SEND_ACK_TIMEOUT_MS = 10_000

/**
 * Id for one outbound reply, used to match the optimistic bubble against the
 * server's echo. `crypto.randomUUID` exists only in a secure context, and the
 * admin app is routinely opened over plain http against a LAN host while a
 * shift is being trained or a deployment smoke-tested. Reaching for it
 * directly would throw inside Send — a hard crash of the one control this
 * whole change exists to make trustworthy — so fall back rather than assume.
 * The fallback only has to be unique within one clerk's open transcript.
 */
export const newClientMsgId = (): string => {
  const webcrypto = globalThis.crypto
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Union the rows we already hold with the ones the server just sent, letting
 * the server win on any id we have both copies of.
 *
 * The gateway joins `support:conv:<id>` BEFORE it reads the history, which
 * closes the hole where a message sent during the watch handshake landed in
 * neither the snapshot nor the room. The cost is that the reverse ordering —
 * a live support:message arriving ahead of the support:thread snapshot that
 * was supposed to contain it — is now the likelier race, and the old
 * wholesale `messages.value = payload.messages` threw that message away. It
 * also preserves a reply the clerk fired while a reconnect was in flight.
 */
export const mergeSupportMessages = (
  existing: InboxMessage[],
  incoming: SupportMessage[],
): InboxMessage[] => {
  const byId = new Map<string, InboxMessage>()
  for (const message of existing) byId.set(message.id, message)

  for (const message of incoming) {
    // A confirmed message supersedes the optimistic bubble it was sent as.
    // The local row is keyed on clientMsgId because it has no server id yet,
    // so it has to be evicted by hand before the real row goes in — otherwise
    // the clerk watches their own reply appear twice.
    //
    // `failed` counts as well as `pending`. A missing ack only proves the
    // answer did not come back, never that the message was not stored, so the
    // late echo of a bubble the timeout already gave up on is exactly the
    // case that most needs collapsing: leaving it would show the clerk their
    // reply twice, once of the two captioned "Not delivered".
    if (message.clientMsgId) {
      for (const [id, held] of byId) {
        if ((held.pending || held.failed) && held.clientMsgId === message.clientMsgId) {
          byId.delete(id)
        }
      }
    }
    byId.set(message.id, message)
  }

  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
}

/** Which subsystem put the current banner up — see clearTransientError. */
type InboxErrorSource = 'live' | 'transient'

/**
 * Which banner class a gateway error code belongs to.
 *
 * `SUPPORT_UNAUTHENTICATED` is the gateway saying this socket was admitted but
 * is deaf — a fact about the CONNECTION, not about the action that happened to
 * expose it — so it has to outlive a successful queue read the way the
 * reconnect banner does.
 *
 * Shared by the `support:error` handler and the send ack because both see the
 * same code for the same event, and the gateway emits `support:error` BEFORE
 * it calls the ack. Classifying in only one of them meant the ack landed last
 * and quietly downgraded the live banner the handler had just raised, after
 * which the next successful queue read cleared it — leaving the clerk looking
 * at a healthy-looking inbox on a socket the server had already said it would
 * not listen to.
 */
const errorSourceFor = (code: string | null | undefined): InboxErrorSource =>
  code === 'SUPPORT_UNAUTHENTICATED' ? 'live' : 'transient'

export const useSupportInbox = () => {
  const auth = useAdminAuth()
  const api = useAdminApi()
  const config = useRuntimeConfig()

  const socket = useState<Socket | null>('support_admin_socket', () => null)
  // The user the live socket was built for. The server stamps socket.data
  // .userId once, at handshake, and never revalidates it, so a socket that
  // outlives a shift change keeps acting as the clerk who opened it.
  const socketUserId = useState<string | null>('support_admin_socket_user', () => null)
  const connected = useState('support_admin_connected', () => false)
  const queue = useState<SupportQueueItem[]>('support_queue', () => [])
  const filter = useState<'unassigned' | 'mine' | 'all' | 'resolved'>(
    'support_filter',
    () => 'unassigned',
  )
  const active = useState<SupportConversation | null>('support_active', () => null)
  const messages = useState<InboxMessage[]>('support_active_messages', () => [])
  // The thread the clerk has asked for, set the moment they click rather than
  // when the snapshot comes back. `active` lags it by a round trip, and a
  // live message that arrives inside that gap has to be routed on intent.
  const watched = useState<string | null>('support_watched', () => null)
  const unassignedCount = useState('support_unassigned_count', () => 0)
  const error = useState<string | null>('support_admin_error', () => null)
  const errorSource = useState<InboxErrorSource | null>('support_admin_error_source', () => null)

  // Timer handles and the queue request token. These are not display state;
  // they live in useState only so that a disconnectInbox() called from a
  // different composable invocation — useAdminAuth().logout() — can cancel
  // the work this one started.
  const runtime = useState<{
    queueSeq: number
    queueInFlight: boolean
    queueDebounce: ReturnType<typeof setTimeout> | null
    tokenRefresh: ReturnType<typeof setInterval> | null
    sessionSeq: number
  }>('support_admin_runtime', () => ({
    queueSeq: 0,
    queueInFlight: false,
    queueDebounce: null,
    tokenRefresh: null,
    sessionSeq: 0,
  }))

  const setError = (message: string, source: InboxErrorSource) => {
    error.value = message
    errorSource.value = source
  }

  // Clears everything except the connection banner. A queue read succeeding
  // proves the API is reachable over HTTP; it proves nothing about whether
  // the websocket feeding this page is still authenticated, and that banner
  // is the only thing telling the clerk their inbox has gone quiet.
  const clearTransientError = () => {
    if (errorSource.value === 'live') return
    error.value = null
    errorSource.value = null
  }

  // Monotonic request token, plus the filter the request was issued for.
  // Without it, switching from `unassigned` to `mine` and back races the two
  // fetches: if the first resolves last it paints the wrong list under the
  // wrong highlighted tab. Same idiom as SupportPlayerContext's `requestSeq`.
  const refreshQueue = async () => {
    const seq = ++runtime.value.queueSeq
    const issuedFor = filter.value
    runtime.value.queueInFlight = true
    try {
      const result = await api.getSupportQueue(issuedFor)
      if (seq !== runtime.value.queueSeq || issuedFor !== filter.value) return
      queue.value = result.items
      unassignedCount.value = result.unassignedCount
      clearTransientError()
    } catch (e: any) {
      if (seq !== runtime.value.queueSeq) return
      setError(e?.data?.error ?? 'Could not load the queue', 'transient')
    } finally {
      if (seq === runtime.value.queueSeq) runtime.value.queueInFlight = false
    }
  }

  // Every socket-driven queue read goes through here. The three events that
  // move the list (a message, a status change, a queue-update we cannot patch
  // in place) all fire together during a busy minute, and each one used to
  // cost a round trip.
  const queueRefreshSoon = () => {
    if (runtime.value.queueDebounce) clearTimeout(runtime.value.queueDebounce)
    runtime.value.queueDebounce = setTimeout(() => {
      runtime.value.queueDebounce = null
      if (runtime.value.queueInFlight) {
        // One is already in the air, and it was issued before the events we
        // are reacting to — so it cannot answer them. Re-arm instead of
        // stacking a second concurrent read.
        queueRefreshSoon()
        return
      }
      void refreshQueue()
    }, QUEUE_REFRESH_DEBOUNCE_MS)
  }

  // Patch one row rather than refetch the whole queue.
  //
  // Deliberately narrow: membership in the current filter is the server's
  // decision (listQueue's where clause), and re-implementing it here would be
  // a second copy to keep in sync. So a row is only patched when it is
  // already listed AND the two fields that decide membership — status and
  // assignedToId — are unchanged. Anything that might add or remove a row
  // falls through to the debounced refetch, which costs one request per 400ms
  // window no matter how many rows move.
  const applyQueueItem = (item: SupportQueueItem) => {
    const held = queue.value.find((row) => row.id === item.id)
    if (!held || held.status !== item.status || held.assignedToId !== item.assignedToId) {
      queueRefreshSoon()
      return
    }
    queue.value = queue.value
      .map((row) => (row.id === item.id ? item : row))
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
  }

  const disconnectInbox = () => {
    if (runtime.value.queueDebounce) {
      clearTimeout(runtime.value.queueDebounce)
      runtime.value.queueDebounce = null
    }
    if (runtime.value.tokenRefresh) {
      clearInterval(runtime.value.tokenRefresh)
      runtime.value.tokenRefresh = null
    }
    // Invalidate anything still in the air. A queue read issued as the
    // previous clerk logged out must not land afterwards and repopulate a
    // list the next clerk is about to be shown, and a connectInbox() parked
    // on its opening await must not go on to build the socket this call is
    // tearing down.
    runtime.value.queueSeq++
    runtime.value.sessionSeq++
    runtime.value.queueInFlight = false

    socket.value?.disconnect()
    socket.value = null
    socketUserId.value = null
    connected.value = false
    watched.value = null
    queue.value = []
    messages.value = []
    active.value = null
    unassignedCount.value = 0
    error.value = null
    errorSource.value = null
  }

  const connectInbox = async () => {
    const currentUserId = (auth.user.value?.id as string | undefined) ?? null

    // Identity check FIRST, before the queue read. `socket` lives in useState
    // and survives SPA navigation, so after a shift change the page found a
    // perfectly connected socket still carrying the previous clerk's
    // handshake. Refreshing the queue before checking would fetch clerk B's
    // list over clerk B's token while every claim and reply still went out as
    // clerk A.
    if (socket.value && socketUserId.value !== currentUserId) disconnectInbox()

    // Taken after the identity teardown above, which bumps it itself.
    const session = runtime.value.sessionSeq
    await refreshQueue()
    // The clerk can navigate away — or log out, which apiFetch can trigger
    // from inside the read we just awaited — while that request is in flight.
    // onUnmounted has then already run disconnectInbox(), and going on to
    // build the socket here would leave a connected inbox and a ten-minute
    // token-refresh interval behind a page nobody is looking at, with nothing
    // left mounted to ever tear either of them down.
    if (session !== runtime.value.sessionSeq) return
    if (socket.value?.connected) return

    // A disconnected socket is not a dead socket — socket.io keeps retrying it
    // in the background. Overwriting the ref without tearing the old one down
    // left it alive with a full set of listeners, so as soon as it came back
    // every support:message was handled twice: each reply appended to the
    // transcript twice, and two refreshQueue() round-trips per event.
    socket.value?.disconnect()

    // Reset on every `connect`, set by anything saying this socket is not
    // actually usable. The liveness window in the connect handler only takes
    // the reconnect banner down if this is still false when it closes.
    let livenessComplaint = false
    let connectGeneration = 0

    // `auth` as a CALLBACK, not a literal. Admin access tokens expire in 15
    // minutes; a literal snapshots the token at connect time, so the first
    // reconnect after expiry re-presents a dead token and the socket drops out
    // silently — the clerk keeps staring at a queue that stopped updating.
    // The callback form is re-invoked on every reconnect attempt, and it
    // awaits a refresh when the cookie has already gone: reconnecting with
    // `undefined` is how the socket came back mute rather than erroring.
    socket.value = io(config.public.wsUrl as string, {
      auth: async (cb: (data: { token: string | null | undefined }) => void) =>
        cb({ token: auth.accessToken.value ?? (await auth.refresh()) }),
      transports: ['polling', 'websocket'],
    })
    socketUserId.value = currentUserId

    if (runtime.value.tokenRefresh) clearInterval(runtime.value.tokenRefresh)
    runtime.value.tokenRefresh = setInterval(() => {
      void auth.refresh()
    }, TOKEN_REFRESH_MS)

    // A silently dead socket is the failure mode that actually hurts here, so
    // surface it rather than letting the queue quietly freeze.
    socket.value.on('connect_error', (err: Error) => {
      livenessComplaint = true
      connected.value = false
      setError(
        `Live updates disconnected (${err.message}). Reload if the queue looks stale.`,
        'live',
      )
    })

    socket.value.on('disconnect', (reason: string) => {
      connected.value = false
      // 'io client disconnect' is our own teardown; anything else is unplanned.
      if (reason !== 'io client disconnect') {
        setError('Live updates disconnected. Reconnecting…', 'live')
      }
    })

    socket.value.on('connect', () => {
      connected.value = true
      livenessComplaint = false
      const generation = ++connectGeneration

      // Deliberately NOT `error.value = null` here. `connect` only means the
      // transport came up. The support gateway has to admit a socket whose
      // token failed to verify — one shared io() also serves anonymous game
      // spectators and cannot eject them — and objects with a support:error a
      // beat after the handshake instead. Clearing the banner on `connect`
      // erased that objection and left the clerk trusting an inbox that had
      // silently stopped receiving anything. Give the server its beat, and
      // only call the connection healthy if nothing complained.
      setTimeout(() => {
        if (generation !== connectGeneration) return
        if (!socket.value?.connected || livenessComplaint) return
        error.value = null
        errorSource.value = null
      }, CONNECT_LIVENESS_MS)

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
      // A snapshot for a thread the clerk has already clicked away from is
      // stale by definition — dropping it is what stops a slow response for
      // thread A from painting itself over thread B.
      if (watched.value && payload.conversation.id !== watched.value) return
      active.value = payload.conversation
      messages.value = mergeSupportMessages(messages.value, payload.messages)
    })

    socket.value.on('support:message', (message: SupportMessage) => {
      if (message.conversationId === watched.value) {
        messages.value = mergeSupportMessages(messages.value, [message])
        // Reading it as it arrives is what keeps the queue badge from
        // climbing on the very thread the clerk is sitting in front of.
        //
        // Only for a PLAYER message. markReadByAgent stamps player rows and
        // unreadForAgent counts them, so a read on the clerk's own echoed
        // reply updates nothing — but the server still answers it with a
        // broadcastQueue to every clerk on shift, which is precisely the
        // per-message fan-out the debounce above exists to stop.
        if (message.senderRole === 'PLAYER') {
          socket.value?.emit('support:read', { conversationId: message.conversationId })
        }
      }
      // A message on any thread reorders the list and changes previews.
      queueRefreshSoon()
    })

    socket.value.on('support:status', (conversation: SupportConversation) => {
      if (conversation.id === active.value?.id) active.value = conversation
      queueRefreshSoon()
    })

    // Payload types come from shared-types. Hand-typing a narrower shape here
    // silently drops fields — an inlined `{ message: string }` for support:error
    // discards `code`, so nothing downstream can ever tell a rate-limit from a
    // permission denial.
    socket.value.on('support:queue-update', (payload: QueueUpdate) => {
      unassignedCount.value = payload.unassignedCount
      if (payload.item) applyQueueItem(payload.item)
      else queueRefreshSoon()
    })

    socket.value.on(
      'support:error',
      (payload: { conversationId?: string; code: string; message: string }) => {
        // SUPPORT_UNAUTHENTICATED is the gateway telling us this socket was
        // admitted but is deaf: it is a connection-health fact, not a failed
        // action, so it outranks the transient banners and must survive a
        // successful queue read.
        const source = errorSourceFor(payload.code)
        if (source === 'live') livenessComplaint = true
        setError(payload.message, source)
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
    clearTransientError()
    const previous = watched.value
    if (previous && previous !== conversationId) {
      // Leave the room we are done with. Guarded on the id actually changing:
      // the reconnect handler re-watches the thread the clerk still has open,
      // and unwatching a room they are still standing in is a far worse
      // failure than the leak this fixes — support:claim rejoins the room, so
      // a spurious leave would go unnoticed until the next silent thread.
      socket.value?.emit('support:unwatch', { conversationId: previous })
      // Drop the rows we hold before the new snapshot lands. The gateway now
      // joins the room before reading history, so a live message for the new
      // thread can arrive first — and appending it onto the previous thread's
      // transcript is exactly the mixing this clear prevents.
      messages.value = []
    }
    watched.value = conversationId
    socket.value?.emit('support:watch', { conversationId })
    socket.value?.emit('support:read', { conversationId })
  }

  const claim = (conversationId: string) => socket.value?.emit('support:claim', { conversationId })
  const release = (conversationId: string) =>
    socket.value?.emit('support:release', { conversationId })
  const resolve = (conversationId: string) =>
    socket.value?.emit('support:resolve', { conversationId })

  const markSendFailed = (clientMsgId: string) => {
    messages.value = messages.value.map((message) =>
      message.pending && message.clientMsgId === clientMsgId
        ? { ...message, pending: false, failed: true }
        : message,
    )
  }

  /**
   * Resolves true only once the gateway has acknowledged the message. The
   * caller keeps its draft until then: a reply refused by the rate limiter or
   * lost to a dying socket used to be silently deleted from the composer, and
   * the clerk found out from the player.
   */
  const reply = (body: string, clientMsgId: string): Promise<boolean> => {
    const trimmed = body.trim()
    const conversation = active.value
    if (!trimmed || !conversation) return Promise.resolve(false)

    // `active` is set from the support:thread snapshot, `watched` from the
    // click, so between clicking a row and the snapshot landing they name two
    // different threads. Sending in that window addressed `active` — the
    // thread the clerk had just clicked AWAY from — so the reply reached the
    // wrong player, and its optimistic bubble was stranded in a transcript
    // that would never carry the echo to collapse it: the settle paths below
    // are all keyed on `watched`, so the row sat on "Sending…" for good.
    // Refuse instead; the draft survives and the clerk can send a beat later.
    if (watched.value !== conversation.id) {
      setError('Still opening that conversation — send again in a moment.', 'transient')
      return Promise.resolve(false)
    }

    // Refuse to hand the payload to a disconnected socket. socket.io does not
    // throw on one — it parks the emit in its sendBuffer and replays it on the
    // next connect. That replay is what the player saw as a duplicate reply:
    // the clerk, having watched their message apparently vanish, retyped it,
    // and the buffer delivered the first copy behind the second. The Send
    // button is disabled for the same reason; this is the guard behind it.
    if (!socket.value?.connected) {
      setError('Not connected — the reply was not sent. It is still in the box.', 'live')
      return Promise.resolve(false)
    }

    const optimistic: InboxMessage = {
      // The clientMsgId doubles as the local row id: it keeps the pending row
      // addressable by the same key the server echoes back, and it cannot
      // collide with a real id.
      id: clientMsgId,
      conversationId: conversation.id,
      senderRole: 'AGENT',
      senderId: (auth.user.value?.id as string | undefined) ?? null,
      body: trimmed,
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: new Date().toISOString(),
      clientMsgId,
      pending: true,
    }
    messages.value = [...messages.value, optimistic]

    return new Promise<boolean>((done) => {
      let settled = false

      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok && watched.value === conversation.id) markSendFailed(clientMsgId)
        done(ok)
      }

      const timer = setTimeout(() => settle(false), SEND_ACK_TIMEOUT_MS)

      socket.value?.emit(
        'support:send',
        { conversationId: conversation.id, clientMsgId, body: trimmed },
        (result: SendAck) => {
          if (!result?.ok) {
            // Classified by the ack's own code rather than assumed transient.
            // The gateway emits support:error before it calls this ack, so a
            // blanket 'transient' here overwrote the live banner that handler
            // had just raised — see errorSourceFor.
            setError(result?.message ?? 'The reply was not accepted.', errorSourceFor(result?.code))
            settle(false)
            return
          }
          // The broadcast of this same message is what normally replaces the
          // pending row; merging the acked copy too covers the ordering where
          // the ack wins the race, and is a no-op when the broadcast got here
          // first.
          if (watched.value === conversation.id) {
            messages.value = mergeSupportMessages(messages.value, [result.message])
          }
          settle(true)
        },
      )
    })
  }

  return {
    queue,
    filter,
    active,
    messages,
    unassignedCount,
    error,
    connected,
    connectInbox,
    disconnectInbox,
    setFilter,
    watchThread,
    claim,
    release,
    resolve,
    reply,
    refreshQueue,
  }
}
