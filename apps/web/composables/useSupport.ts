import type {
  SupportConversation,
  SupportConversationWithMessages,
  SupportContactInfo,
  SupportMessage,
} from '@world-bingo/shared-types'

/** How long a thread may sit unanswered before the widget reveals a phone
 *  number. Client-side on purpose: a server sweep would double-fire across
 *  API instances, and the widget already knows escalatedAt. */
export const CONTACT_REVEAL_MS = 5 * 60 * 1000

/**
 * Pure decision for whether (and when) to reveal the fallback contact
 * details for a thread. No Nuxt runtime deps — kept testable outside a
 * Nuxt context, mirroring `buildBrandStyle` in `useBrand.ts`.
 *
 * Only an OPEN thread with an `escalatedAt` timestamp ever reveals: BOT
 * threads haven't asked for a human, ASSIGNED threads are being actively
 * worked by a clerk, and RESOLVED threads are done.
 */
export function contactRevealPlan(
  conversation: { status: string; escalatedAt: string | null } | null,
  now: number,
): { reveal: boolean; delayMs: number | null } {
  if (!conversation || conversation.status !== 'OPEN' || !conversation.escalatedAt) {
    return { reveal: false, delayMs: null }
  }

  const waited = now - new Date(conversation.escalatedAt).getTime()
  if (waited >= CONTACT_REVEAL_MS) {
    return { reveal: true, delayMs: null }
  }

  return { reveal: false, delayMs: CONTACT_REVEAL_MS - waited }
}

// Admin-configured contact fields (Task 7) are stored without format
// validation, so anything the panel turns into a clickable `href` has to be
// sanitized here rather than trusted. Both helpers are allowlists — only
// characters that are legitimate in a phone number / Telegram handle pass —
// rather than a blocklist for `javascript:`-style schemes, since a blocklist
// only ever catches the variant you thought of. Non-null returns are the
// only ones the template renders as a link.
const TEL_HREF_ALLOWED = /^[0-9+\-() .]+$/
const TELEGRAM_HANDLE_ALLOWED = /^[A-Za-z0-9_]+$/

/** Build a `tel:` href from an admin-configured phone number, or `null` if
 *  the stored value contains anything outside digits/+/-/()/space — which
 *  also rejects a scheme-smuggling value like `javascript:alert(1)`. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed || !TEL_HREF_ALLOWED.test(trimmed)) return null
  return `tel:${trimmed}`
}

/** Build a `https://t.me/<handle>` href from an admin-configured Telegram
 *  handle (with or without a leading `@`), or `null` if what remains after
 *  stripping `@` isn't a plain alphanumeric/underscore handle. */
export function telegramHref(handle: string): string | null {
  const trimmed = handle.trim()
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  if (!withoutAt || !TELEGRAM_HANDLE_ALLOWED.test(withoutAt)) return null
  return `https://t.me/${withoutAt}`
}

/**
 * Whether a contact payload actually offers the player somewhere to go.
 *
 * `ensureDefaults` seeds `support_phone` / `support_telegram` / `support_hours`
 * as EMPTY STRINGS, so a freshly deployed brand answers `GET /settings/support`
 * with a complete-looking object containing nothing. Rendering the block off
 * `contact != null` therefore painted a "Need us faster?" heading over an empty
 * box on every new deployment. `hours` deliberately doesn't count: it is a
 * caption for a channel, not a channel.
 */
export function hasUsableContactChannel(contact: SupportContactInfo | null): boolean {
  if (!contact) return false
  return telHref(contact.phone) !== null || telegramHref(contact.telegram) !== null
}

/** A `SupportMessage` plus the local-only delivery state of the player's own
 *  optimistic bubble. `sendState` never arrives from the server — a row that
 *  carries one has not been confirmed persisted, and a `failed` row is the
 *  only thing in the transcript the player can tap to retry. */
export type SupportMessageView = SupportMessage & { sendState?: 'pending' | 'failed' }

/**
 * Merge server-sent messages into what the client already holds.
 *
 * Both the transcript snapshot (`support:thread`) and the live broadcast
 * (`support:message`) go through here, because neither is authoritative on its
 * own: the server joins the conversation room BEFORE it reads history, so a
 * message broadcast during that handshake arrives ahead of the snapshot that
 * doesn't contain it — and replacing `messages` wholesale with the snapshot
 * would drop it. Three rules, in order:
 *
 *  1. Same `id` — the server copy replaces what we hold (and with it any local
 *     `sendState`, since a row the server echoed back is committed).
 *  2. Same `clientMsgId` — this is the sender's own optimistic bubble coming
 *     back with its real id. Replace in place; appending would show the
 *     player's message twice.
 *  3. Otherwise append.
 *
 * The result is sorted by `createdAt` so a message that raced the snapshot
 * lands in its real position rather than at the end. `Array.prototype.sort` is
 * stable, so rows sharing a timestamp keep their arrival order.
 */
export function reconcileMessages(
  existing: SupportMessageView[],
  incoming: SupportMessage[],
): SupportMessageView[] {
  const merged: SupportMessageView[] = [...existing]
  const indexById = new Map<string, number>()
  const indexByClientMsgId = new Map<string, number>()

  merged.forEach((message, index) => {
    indexById.set(message.id, index)
    if (message.clientMsgId) indexByClientMsgId.set(message.clientMsgId, index)
  })

  for (const message of incoming) {
    const known =
      indexById.get(message.id) ??
      (message.clientMsgId ? indexByClientMsgId.get(message.clientMsgId) : undefined)

    if (known !== undefined) {
      merged[known] = message
      indexById.set(message.id, known)
      if (message.clientMsgId) indexByClientMsgId.set(message.clientMsgId, known)
      continue
    }

    merged.push(message)
    indexById.set(message.id, merged.length - 1)
    if (message.clientMsgId) indexByClientMsgId.set(message.clientMsgId, merged.length - 1)
  }

  return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

/** Server error codes that describe a passing condition rather than a broken
 *  one. They clear themselves so the banner doesn't sit under a working
 *  composer telling the player something that stopped being true. */
const TRANSIENT_ERROR_CODES = new Set(['SUPPORT_RATE_LIMITED'])

/** How long a transient error stays on screen. Long enough to read, short
 *  enough that the next send isn't made under a stale warning. */
export const TRANSIENT_ERROR_MS = 8000

export interface SupportErrorPlan {
  message: string | null
  code: string | null
  clearAfterMs: number | null
}

/**
 * Pure error-lifecycle decision: what the banner should say, and whether it
 * expires on its own.
 *
 * Worth extracting because the previous lifecycle had no way out of one state.
 * `send()` cleared the error only AFTER its `!conversation` guard, so in
 * exactly the situation the error described — no conversation, e.g. after the
 * socket lost its token — nothing the player could do would ever clear it, and
 * `role="alert"` re-announced the stale failure to a screen reader.
 *
 * Passing `null` is the explicit "clear it" case; every caller that knows the
 * error is stale (open, close, a delivered transcript, a fresh send) uses it.
 */
export function supportErrorPlan(
  payload: { code?: string | null; message: string } | null,
): SupportErrorPlan {
  if (!payload) return { message: null, code: null, clearAfterMs: null }
  const code = payload.code ?? null
  return {
    message: payload.message,
    code,
    clearAfterMs: code && TRANSIENT_ERROR_CODES.has(code) ? TRANSIENT_ERROR_MS : null,
  }
}

/** Mirrors `ALLOWED_MIME_TYPES` in `apps/api/src/lib/storage.ts`. Copied, not
 *  imported: the two apps are separate builds with no shared runtime module,
 *  and shared-types carries contracts rather than server config. Keep the two
 *  lists in step — a narrower list here silently stops iPhone HEIC picks that
 *  the server would have accepted. */
export const SUPPORT_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]

/** Mirrors `MAX_FILE_SIZE` in `apps/api/src/lib/storage.ts`. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024

/** Extension fallback for the allowlist above. Several Android and iOS
 *  pickers hand back a `File` with an EMPTY `type` (notably HEIC straight out
 *  of the camera roll), so a MIME-only check would reject exactly the photos
 *  the server accepts. */
const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
}

/**
 * Reject an attachment the server is going to reject anyway, before the upload
 * starts. On a 3G phone the upload of a 12 MB camera photo runs for minutes
 * before the API answers 400 — the player watches a spinner and then loses the
 * file. This is a pure guard over the same limits the server enforces; it is
 * not a substitute for them.
 */
export function attachmentPrecheck(file: {
  name: string
  size: number
  type: string
}): { ok: true } | { ok: false; message: string } {
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, message: 'That image is over 5 MB. Try a smaller one.' }
  }

  const declared = file.type.toLowerCase()
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const effective = declared || EXTENSION_MIME[extension] || ''

  if (!SUPPORT_ATTACHMENT_MIME_TYPES.includes(effective)) {
    return { ok: false, message: 'Only images can be attached (JPG, PNG, WEBP, HEIC).' }
  }

  return { ok: true }
}

/** Slack, in pixels, for treating a transcript as "scrolled to the bottom".
 *  Not zero: sub-pixel layout and the browser's own scroll rounding leave a
 *  pinned list a fraction of a pixel short of its own scrollHeight. */
export const SCROLL_PIN_SLACK_PX = 48

/**
 * Whether the transcript is close enough to the bottom that appending a
 * message should scroll to it. Pure so the decision can be tested without a
 * DOM: the caller passes the three numbers it reads off the element.
 *
 * Auto-scrolling unconditionally yanked a player who had scrolled up to read
 * an earlier reply straight back down every time anything arrived — including
 * their own attachment finishing its upload.
 */
export function isPinnedToBottom(view: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= SCROLL_PIN_SLACK_PX
}

/** How long after a socket-delivered agent reply a `SUPPORT_REPLY`
 *  notification for the same thread is treated as that reply's echo. */
export const SUPPORT_REPLY_ECHO_MS = 15_000

export interface SupportUnreadState {
  isOpen: boolean
  conversationId: string | null
  /** When the last agent reply arrived over the conversation room, or null. */
  lastSocketReplyAt: number | null
}

/**
 * Pure decision for the launcher badge, over the two cues that can announce an
 * agent reply.
 *
 * The server now creates a `SUPPORT_REPLY` notification on EVERY agent
 * message, unconditionally — the old `fetchSockets` gate meant a player who
 * was connected but had never opened the panel (and so was in no conversation
 * room) got neither the broadcast nor the notification, and the reply reached
 * them nowhere at all. The cost of removing the gate is that a player who IS
 * in the room now gets both cues for one reply, so the badge has to know they
 * are the same event:
 *
 *  - A socket cue always records its arrival time, whether or not it bumped
 *    the badge, because it is the thing a following notification echoes.
 *  - A notification cue is dropped when the panel is open on that thread (the
 *    reply is already on screen) or when a socket cue for it just landed.
 *  - Otherwise the notification is the only cue there is, and it counts.
 */
export function supportUnreadPlan(
  cue: { kind: 'socket' | 'notification'; conversationId: string | null },
  state: SupportUnreadState,
  now: number,
): { bump: boolean; lastSocketReplyAt: number | null } {
  if (cue.kind === 'socket') {
    return { bump: !state.isOpen, lastSocketReplyAt: now }
  }

  if (state.isOpen && cue.conversationId !== null && cue.conversationId === state.conversationId) {
    return { bump: false, lastSocketReplyAt: state.lastSocketReplyAt }
  }

  const echoed =
    state.lastSocketReplyAt !== null && now - state.lastSocketReplyAt <= SUPPORT_REPLY_ECHO_MS

  return { bump: !echoed, lastSocketReplyAt: state.lastSocketReplyAt }
}

/** Id for one outbound message, used to reconcile the optimistic bubble with
 *  the server's echo. `crypto.randomUUID` only exists in a secure context and
 *  the player app is routinely opened over plain http against a LAN host
 *  during testing, where reaching for it straight would throw on every send. */
export function newClientMsgId(): string {
  const webcrypto = globalThis.crypto
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** How long to wait for the server's ack before the bubble goes to `failed`.
 *  The bubble is NEVER auto-retried when this fires: a missing ack proves the
 *  answer did not come back, not that the message failed to persist, and an
 *  automatic resend would post the player's message twice. */
export const ACK_TIMEOUT_MS = 10_000

/** How long the panel skeletons before it admits the transcript is not coming.
 *  The skeleton is an improvement on claiming an established thread is empty,
 *  but only while it is bounded — an unbounded one is a hang. Generous, because
 *  this fires on a slow connection, not just a broken one. */
export const THREAD_TIMEOUT_MS = 15_000

/** Every event this app binds on the shared player socket. `connect` and
 *  `notification:new` are in here deliberately: neither is a support event,
 *  but both are ones this composable attaches, and the rebinding below has to
 *  know about every handler it owns in order to remove exactly those and
 *  nothing else. */
export const SUPPORT_EVENTS = [
  'connect',
  'notification:new',
  'support:thread',
  'support:message',
  'support:status',
  'support:contact-fallback',
  'support:error',
] as const

export type SupportEvent = (typeof SUPPORT_EVENTS)[number]

/** Handlers `bindSupportListeners` last attached, per socket. A WeakMap rather
 *  than a flag or a module-level `let`: `useSocket()` hands out a different
 *  Socket after every reconnect, and keying on the instance means an old one
 *  can be garbage collected without leaving an entry behind. */
const boundHandlers = new WeakMap<object, Array<[SupportEvent, (payload: any) => void]>>()

/**
 * Attach the support listeners to `socket`, first dropping the ones this app
 * attached to it before. No Nuxt runtime deps — testable with a fake socket
 * outside a Nuxt context, mirroring `contactRevealPlan` above.
 *
 * `useSocket().connect()` builds a BRAND NEW Socket whenever the current one
 * isn't connected, and a dropped transport, a sleeping tab or an explicit
 * `disconnect()` all leave the player with a different instance. Binding once
 * behind a sticky `bound` flag therefore left every socket after the first
 * with no support listeners at all: `support:open` still went out, the server
 * still answered with `support:thread`, and nothing caught it — so
 * `conversation` stayed null, `send()` bailed on its `!conversation.value`
 * guard, and support chat was dead until a full page reload.
 *
 * Removal is BY HANDLER REFERENCE, not by event name. `socket.off(event)`
 * drops every listener on that event, including ones this composable never
 * added — and `useSocket()` is the whole player app's socket, with `connect`
 * handlers belonging to `useSocket` itself and `notification:new` handlers
 * belonging to the notification bell. Clearing by name would silently unhook
 * them. Tracking what we attached keeps this idempotent per socket while
 * leaving every foreign listener alone.
 */
export function bindSupportListeners<
  S extends {
    on(event: any, handler: any): unknown
    off(event: any, handler?: any): unknown
  },
>(socket: S, handlers: Array<[SupportEvent, (payload: any) => void]>) {
  for (const [event, handler] of boundHandlers.get(socket) ?? []) {
    socket.off(event, handler)
  }
  for (const [event, handler] of handlers) {
    socket.on(event, handler)
  }
  boundHandlers.set(socket, handlers)
}

/** Module scope, not per-`useSupport()` call. `bind` now re-runs on every
 *  `openChat`, possibly from a different component's composable instance, and
 *  a per-call `let` meant each instance cleared only its OWN pending reveal —
 *  a timer armed by an earlier instance would still fire and flash the phone
 *  number at a thread a clerk had since claimed. One shared handle can't be
 *  orphaned that way. Client-only: nothing arms it during SSR. */
let revealTimer: ReturnType<typeof setTimeout> | null = null

/** Same reasoning as `revealTimer`: the auto-expiring error banner, the
 *  transcript deadline and the per-message ack deadlines are app-wide state,
 *  not per-component. */
let errorTimer: ReturnType<typeof setTimeout> | null = null
let threadTimer: ReturnType<typeof setTimeout> | null = null
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** In-flight `openChat`. `openChat` is called from the launcher, from
 *  `useAppShell` and from two links in `RailsShell`, so a double-tap or a
 *  stray second caller used to run the whole open sequence twice — including
 *  a second `connect()`, which tore down the socket the first one was still
 *  handshaking on. Returning the same promise makes the second caller wait
 *  for the first instead of racing it. */
let openInFlight: Promise<void> | null = null

export const useSupport = () => {
  const { socket, connect } = useSocket()
  const auth = useAuth()
  const config = useRuntimeConfig()

  const isOpen = useState('support_is_open', () => false)
  const conversation = useState<SupportConversation | null>('support_conversation', () => null)
  const messages = useState<SupportMessageView[]>('support_messages', () => [])
  const contact = useState<SupportContactInfo | null>('support_contact', () => null)
  const showContact = useState('support_show_contact', () => false)
  const unread = useState('support_unread', () => 0)
  const error = useState<string | null>('support_error', () => null)
  /** The server code behind `error`, kept so the banner can expire itself on a
   *  transient failure (and so a future translation pass has something to key
   *  on other than the English sentence). */
  const errorCode = useState<string | null>('support_error_code', () => null)
  const sending = useState('support_sending', () => false)
  /** True between `openChat` and the transcript landing. Drives a skeleton so
   *  the panel doesn't claim "Send us a message" at a thread that already has
   *  twenty messages in it. */
  const loading = useState('support_loading', () => false)
  const lastSocketReplyAt = useState<number | null>('support_last_socket_reply', () => null)

  /** Apply a `supportErrorPlan`. Pass `null` to clear. */
  const reportError = (payload: { code?: string | null; message: string } | null) => {
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = null

    const plan = supportErrorPlan(payload)
    error.value = plan.message
    errorCode.value = plan.code

    if (plan.clearAfterMs !== null) {
      errorTimer = setTimeout(() => {
        error.value = null
        errorCode.value = null
      }, plan.clearAfterMs)
    }
  }

  /** Reveal contact details once the thread has waited long enough. Re-armed
   *  on every status change so a claim cancels a pending reveal. Always
   *  clears the previous timer first, so a stale timeout from a thread
   *  that's since been claimed/resolved/replaced can never fire. */
  const armContactReveal = () => {
    if (revealTimer) clearTimeout(revealTimer)
    revealTimer = null

    const plan = contactRevealPlan(conversation.value, Date.now())
    if (plan.reveal) {
      showContact.value = true
      return
    }
    if (plan.delayMs !== null) {
      revealTimer = setTimeout(() => {
        showContact.value = true
      }, plan.delayMs)
    }
  }

  const loadContact = async () => {
    // Guarded on a USABLE payload, not on `contact.value` being set. The catch
    // below used to cache `{ phone: '', telegram: '', hours: '' }`, which
    // satisfied a truthiness guard forever — so one failed request on the
    // first open left the player with no fallback for the rest of the session,
    // including the 5-minute reveal that exists for exactly that situation.
    if (hasUsableContactChannel(contact.value)) return
    try {
      contact.value = await $fetch<SupportContactInfo>(
        `${config.public.apiBase}/settings/support`,
        // The panel paints before this resolves, but a request with no
        // deadline still holds a connection open on a stalled network.
        { timeout: 8000 },
      )
    } catch {
      // Leave `contact` as it was so the next open retries.
    }
  }

  /** Stop skeletoning, whatever the reason. */
  const settleLoading = () => {
    if (threadTimer) clearTimeout(threadTimer)
    threadTimer = null
    loading.value = false
  }

  const markRead = (conversationId: string | undefined | null) => {
    if (!conversationId) return
    socket.value?.emit('support:read', { conversationId })
  }

  /**
   * Dismiss the notification-rail row for a reply the player is already
   * looking at.
   *
   * The server now raises a SUPPORT_REPLY notification on EVERY agent message
   * — the old "skip it if they have a socket" gate was the bug that lost
   * replies entirely, so it is gone. That is right for a player who is away,
   * and wrong for one who is watching the panel: without this, a normal
   * back-and-forth conversation deposits one "Support replied" row in the bell
   * per clerk turn, and the player closes the chat to find ten of them.
   *
   * The bell lists unread rows only (`GET /user/notifications`), so marking it
   * read is enough to keep it out. Fire-and-forget on purpose: the badge
   * suppression above has already happened locally, and a failed dismissal is
   * a stale bell row, not a broken chat.
   */
  const dismissReplyCue = (notificationId: string) => {
    if (!auth.token) return
    void $fetch(`${config.public.apiBase}/user/notifications/${notificationId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    }).catch(() => {})
  }

  /** Re-bound on every `openChat`, because `connect()` may well have handed
   *  us a different Socket than the one we bound last time. */
  const bind = () => {
    if (!socket.value) return

    bindSupportListeners(socket.value, [
      [
        // Socket.io rooms do not survive a reconnect: the server builds a
        // fresh Socket with a new id, and it belongs to no room until it
        // joins one again. `support:conv:<id>` is only ever joined by the
        // `support:open` / `support:watch` handlers, so a transport drop
        // while the panel is open silently took the player out of their own
        // thread — agent replies stopped arriving, and so did the echo of
        // the player's own sends, with the panel still looking healthy
        // (`conversation` set, Send enabled). Re-opening rejoins the room
        // AND returns the transcript, which also backfills whatever was said
        // while the socket was down; rejoining alone would leave a hole.
        //
        // Guarded on an existing conversation so this never opens a thread
        // for a player who has not asked for support: `connect` fires for
        // every reconnect of the shared app socket, not just support ones,
        // and since these listeners are now bound at app start (see
        // plugins/01.support.client.ts) an unguarded emit would open a
        // support thread for every player who merely loads the app.
        'connect',
        () => {
          if (conversation.value) socket.value?.emit('support:open')
        },
      ],
      [
        // The other half of the badge. A reply that arrives before the player
        // has ever opened the panel reaches them only as a notification —
        // they are in `user:<id>` but in no conversation room — so the badge
        // has to listen here too. `supportUnreadPlan` owns the de-duplication
        // against the socket cue.
        'notification:new',
        (
          notification: {
            id?: string
            type?: string
            metadata?: Record<string, unknown>
          } | null,
        ) => {
          if (notification?.type !== 'SUPPORT_REPLY') return
          const cueConversationId =
            typeof notification.metadata?.conversationId === 'string'
              ? notification.metadata.conversationId
              : null

          const plan = supportUnreadPlan(
            { kind: 'notification', conversationId: cueConversationId },
            {
              isOpen: isOpen.value,
              conversationId: conversation.value?.id ?? null,
              lastSocketReplyAt: lastSocketReplyAt.value,
            },
            Date.now(),
          )
          if (plan.bump) unread.value += 1

          // Only when the panel is genuinely open on this thread. `plan.bump`
          // is also false for the echo of a socket cue the player has NOT
          // seen — the panel can be closed in that case, and dismissing then
          // would delete the only trace of the reply.
          const watching = isOpen.value && cueConversationId === conversation.value?.id
          if (watching && notification.id) dismissReplyCue(notification.id)
        },
      ],
      [
        'support:thread',
        (payload: SupportConversationWithMessages) => {
          // A DIFFERENT thread (the previous one was resolved and the server
          // opened a fresh one) shares nothing with what we hold, so merging
          // would carry the old transcript into the new conversation.
          const sameThread = payload.conversation.id === conversation.value?.id
          conversation.value = payload.conversation
          messages.value = sameThread
            ? reconcileMessages(messages.value, payload.messages)
            : [...payload.messages]

          settleLoading()
          // A delivered transcript proves any standing error stale.
          reportError(null)

          // Reconnecting is not reading: the server no longer marks the thread
          // read on `support:open`, so a background reconnect while the panel
          // is closed must leave the badge alone.
          if (isOpen.value) {
            unread.value = 0
            markRead(payload.conversation.id)
          }
          armContactReveal()
        },
      ],
      [
        'support:message',
        (message: SupportMessage) => {
          if (message.conversationId !== conversation.value?.id) return
          messages.value = reconcileMessages(messages.value, [message])

          if (message.senderRole === 'PLAYER') return

          const plan = supportUnreadPlan(
            { kind: 'socket', conversationId: message.conversationId },
            {
              isOpen: isOpen.value,
              conversationId: conversation.value?.id ?? null,
              lastSocketReplyAt: lastSocketReplyAt.value,
            },
            Date.now(),
          )
          lastSocketReplyAt.value = plan.lastSocketReplyAt
          if (plan.bump) unread.value += 1

          // Somebody answered — stop counting down to the phone number. This
          // used to hang off `status === 'ASSIGNED'`, which a thread that is
          // answered but never formally claimed never reaches, so the "Need us
          // faster?" strip stayed up under a live conversation. SYSTEM is
          // excluded on purpose: the line the server writes when the player
          // presses "Talk to a person" is not an answer, and clearing on it
          // would hide the phone number that same press just revealed.
          if (message.senderRole === 'AGENT' || message.senderRole === 'AI') {
            showContact.value = false
          }
        },
      ],
      [
        'support:status',
        (updated: SupportConversation) => {
          if (updated.id !== conversation.value?.id) return
          conversation.value = updated
          // A claimed thread is being handled — stop counting down to the
          // phone number.
          if (updated.status === 'ASSIGNED') showContact.value = false
          armContactReveal()
        },
      ],
      [
        'support:contact-fallback',
        (payload: SupportContactInfo) => {
          const next = { phone: payload.phone, telegram: payload.telegram, hours: payload.hours }
          contact.value = next
          // A fallback with nothing to fall back to is worse than none: it
          // paints a heading over an empty box on a brand that has not filled
          // the support settings in.
          showContact.value = hasUsableContactChannel(next)
        },
      ],
      [
        'support:error',
        (payload: { conversationId?: string; code: string; message: string }) => {
          // Cleared on ANY support error, not only one carrying our id: a
          // `support:thread` failure emits with `conversationId: undefined`,
          // and matching on the id would leave the panel skeletoning forever.
          settleLoading()
          reportError(payload)
        },
      ],
    ])
  }

  const runOpenChat = async () => {
    reportError(null)

    if (!auth.token) {
      reportError({ message: 'Sign in to chat with support' })
      isOpen.value = true
      // Signed-out visitors can't open a thread, but the phone/Telegram
      // fallback is their only route to help — load it regardless. No
      // `loading` flag on this path: nothing is coming, so a skeleton here
      // would spin for the life of the page.
      await loadContact()
      return
    }

    // Ordered for first paint. `connect` + `bind` + `isOpen` are synchronous,
    // so the panel is on screen in the same frame as the tap; `support:open`
    // goes out immediately after; and the contact fetch — which nothing in the
    // first paint reads, and which cannot render for five minutes — is left
    // un-awaited. Awaiting it used to hold the panel closed for the length of
    // an HTTP round trip on a phone.
    connect()
    bind()
    isOpen.value = true
    unread.value = 0

    loading.value = true
    if (threadTimer) clearTimeout(threadTimer)
    threadTimer = setTimeout(() => {
      settleLoading()
      reportError({
        code: 'SUPPORT_THREAD_TIMEOUT',
        message: 'Could not load your conversation. Check your connection and try again.',
      })
    }, THREAD_TIMEOUT_MS)

    socket.value?.emit('support:open')
    // Only meaningful on a re-open; on a first open the id arrives with the
    // transcript and that handler marks it read instead.
    markRead(conversation.value?.id)
    void loadContact()
  }

  const openChat = async () => {
    if (openInFlight) return openInFlight
    const pending = runOpenChat().finally(() => {
      // Only retire the handle if it is still ours. `closeChat` drops it too,
      // and a re-open can have installed a newer one by the time this settles.
      if (openInFlight === pending) openInFlight = null
    })
    openInFlight = pending
    return pending
  }

  const closeChat = () => {
    isOpen.value = false
    settleLoading()
    reportError(null)
    markRead(conversation.value?.id)
    // Release the re-entry guard. It exists to collapse a double-tap, not to
    // deafen the launcher: the signed-out branch of `runOpenChat` awaits the
    // contact fetch, so without this a visitor who opened the panel and closed
    // it again got a dead FAB for the rest of that request — up to the 8 s
    // timeout on a stalled network.
    openInFlight = null
  }

  const toggle = () => (isOpen.value ? closeChat() : openChat())

  const clearAckTimer = (clientMsgId: string) => {
    const timer = ackTimers.get(clientMsgId)
    if (timer) clearTimeout(timer)
    ackTimers.delete(clientMsgId)
  }

  const markFailed = (clientMsgId: string) => {
    clearAckTimer(clientMsgId)
    messages.value = messages.value.map((message) =>
      message.clientMsgId === clientMsgId && message.sendState === 'pending'
        ? { ...message, sendState: 'failed' as const }
        : message,
    )
  }

  /**
   * Post a message and show it immediately.
   *
   * Returns the `clientMsgId` of the optimistic bubble, or `null` when nothing
   * was posted at all — which is how the composer knows whether it is safe to
   * clear the draft.
   *
   * The emit is gated on a CONNECTED socket rather than handed to socket.io
   * unconditionally. A disconnected socket buffers the payload in `sendBuffer`
   * and replays it on reconnect, which sounds like the right behaviour and is
   * not: `useSocket().connect()` destroys the buffering socket outright on the
   * next call, so the message evaporated with no error anywhere — and on the
   * paths where the buffer DOES survive, a replay minutes later posts a
   * message the player has long since given up on and retyped.
   */
  const send = (body: string, attachmentUrl?: string, attachmentMime?: string): string | null => {
    // Hoisted ABOVE the guard on purpose. Below it, a player with no
    // conversation — the exact state a support error describes — had no way to
    // clear the banner, because every path that could clear it returned first.
    reportError(null)

    const trimmed = body.trim()
    if ((!trimmed && !attachmentUrl) || !conversation.value) return null

    const clientMsgId = newClientMsgId()
    const optimistic: SupportMessageView = {
      id: `local:${clientMsgId}`,
      conversationId: conversation.value.id,
      senderRole: 'PLAYER',
      senderId: auth.user?.id ?? null,
      body: trimmed,
      attachmentUrl: attachmentUrl ?? null,
      attachmentMime: attachmentMime ?? null,
      createdAt: new Date().toISOString(),
      clientMsgId,
      sendState: 'pending',
    }
    messages.value = [...messages.value, optimistic]

    if (!socket.value?.connected) {
      markFailed(clientMsgId)
      reportError({
        code: 'SUPPORT_OFFLINE',
        message: 'You are offline. Tap the message to retry.',
      })
      return clientMsgId
    }

    ackTimers.set(
      clientMsgId,
      setTimeout(() => {
        // Deliberately no auto-retry: a missing ack says the ANSWER did not
        // come back, not that the write did not happen, and the server does
        // not de-duplicate on `clientMsgId`. Resending here would post the
        // player's message twice into the clerk's inbox.
        markFailed(clientMsgId)
      }, ACK_TIMEOUT_MS),
    )

    socket.value.emit(
      'support:send',
      {
        conversationId: conversation.value.id,
        clientMsgId,
        body: trimmed,
        attachmentUrl,
        attachmentMime,
      },
      (result) => {
        clearAckTimer(clientMsgId)
        if (result.ok) {
          messages.value = reconcileMessages(messages.value, [result.message])
          return
        }
        markFailed(clientMsgId)
        reportError(result)
      },
    )

    return clientMsgId
  }

  /**
   * Re-send a bubble that failed, leaving exactly one copy of it behind.
   *
   * The order matters: send FIRST, drop the old row only once a replacement
   * exists. Dropping it up front reads tidier and quietly deletes the player's
   * text on every path where `send()` returns without posting anything — no
   * conversation, or a body that trims to nothing — which is the one thing a
   * retry affordance must never do to the message it is offering to rescue.
   */
  const retry = (message: SupportMessageView) => {
    if (message.sendState !== 'failed') return
    const resent = send(
      message.body,
      message.attachmentUrl ?? undefined,
      message.attachmentMime ?? undefined,
    )
    if (!resent) return
    messages.value = messages.value.filter((held) => held.id !== message.id)
  }

  const escalate = () => {
    if (!conversation.value) return
    socket.value?.emit('support:escalate', { conversationId: conversation.value.id })
  }

  const uploadAttachment = async (
    file: File,
  ): Promise<{ url: string; mimetype: string } | null> => {
    sending.value = true
    reportError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      return await $fetch<{ url: string; mimetype: string }>(
        `${config.public.apiBase}/support/attachments`,
        { method: 'POST', body: form, headers: { Authorization: `Bearer ${auth.token}` } },
      )
    } catch (e: any) {
      reportError({ message: e?.data?.error ?? 'Upload failed' })
      return null
    } finally {
      sending.value = false
    }
  }

  return {
    isOpen,
    conversation,
    messages,
    contact,
    showContact,
    unread,
    error,
    errorCode,
    sending,
    loading,
    bind,
    toggle,
    openChat,
    closeChat,
    reportError,
    send,
    retry,
    escalate,
    uploadAttachment,
  }
}
