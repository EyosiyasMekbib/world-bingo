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

/** Every event this app binds on the shared player socket. `connect` is in
 *  here deliberately: it is not a support event, but it IS one this composable
 *  attaches, and the rebinding below has to know about every handler it owns
 *  in order to remove exactly those and nothing else. */
export const SUPPORT_EVENTS = [
  'connect',
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
 * handlers belonging to `useSocket` itself and to any other feature. Clearing
 * by name would silently unhook them. Tracking what we attached keeps this
 * idempotent per socket while leaving every foreign listener alone.
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

export const useSupport = () => {
  const { socket, connect } = useSocket()
  const auth = useAuth()
  const config = useRuntimeConfig()

  const isOpen = useState('support_is_open', () => false)
  const conversation = useState<SupportConversation | null>('support_conversation', () => null)
  const messages = useState<SupportMessage[]>('support_messages', () => [])
  const contact = useState<SupportContactInfo | null>('support_contact', () => null)
  const showContact = useState('support_show_contact', () => false)
  const unread = useState('support_unread', () => 0)
  const error = useState<string | null>('support_error', () => null)
  const sending = useState('support_sending', () => false)

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
    if (contact.value) return
    try {
      contact.value = await $fetch<SupportContactInfo>(`${config.public.apiBase}/settings/support`)
    } catch {
      contact.value = { phone: '', telegram: '', hours: '' }
    }
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
        // every reconnect of the shared app socket, not just support ones.
        'connect',
        () => {
          if (conversation.value) socket.value?.emit('support:open')
        },
      ],
      [
        'support:thread',
        (payload: SupportConversationWithMessages) => {
          conversation.value = payload.conversation
          messages.value = payload.messages
          unread.value = 0
          armContactReveal()
        },
      ],
      [
        'support:message',
        (message: SupportMessage) => {
          if (message.conversationId !== conversation.value?.id) return
          messages.value = [...messages.value, message]
          if (!isOpen.value && message.senderRole !== 'PLAYER') unread.value += 1
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
          contact.value = { phone: payload.phone, telegram: payload.telegram, hours: payload.hours }
          showContact.value = true
        },
      ],
      [
        'support:error',
        (payload: { code: string; message: string }) => {
          error.value = payload.message
        },
      ],
    ])
  }

  const openChat = async () => {
    if (!auth.token) {
      error.value = 'Sign in to chat with support'
      isOpen.value = true
      // Signed-out visitors can't open a thread, but the phone/Telegram
      // fallback is their only route to help — load it regardless.
      await loadContact()
      return
    }
    connect()
    bind()
    await loadContact()
    isOpen.value = true
    unread.value = 0
    socket.value?.emit('support:open')
  }

  const closeChat = () => {
    isOpen.value = false
  }

  const toggle = () => (isOpen.value ? closeChat() : openChat())

  const send = (body: string, attachmentUrl?: string, attachmentMime?: string) => {
    const trimmed = body.trim()
    if ((!trimmed && !attachmentUrl) || !conversation.value) return
    error.value = null
    socket.value?.emit('support:send', {
      conversationId: conversation.value.id,
      body: trimmed,
      attachmentUrl,
      attachmentMime,
    })
  }

  const escalate = () => {
    if (!conversation.value) return
    socket.value?.emit('support:escalate', { conversationId: conversation.value.id })
  }

  const uploadAttachment = async (
    file: File,
  ): Promise<{ url: string; mimetype: string } | null> => {
    sending.value = true
    error.value = null
    try {
      const form = new FormData()
      form.append('file', file)
      return await $fetch<{ url: string; mimetype: string }>(
        `${config.public.apiBase}/support/attachments`,
        { method: 'POST', body: form, headers: { Authorization: `Bearer ${auth.token}` } },
      )
    } catch (e: any) {
      error.value = e?.data?.error ?? 'Upload failed'
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
    sending,
    toggle,
    openChat,
    closeChat,
    send,
    escalate,
    uploadAttachment,
  }
}
