import { describe, it, expect } from 'vitest'
import {
  contactRevealPlan,
  CONTACT_REVEAL_MS,
  telHref,
  telegramHref,
  bindSupportListeners,
  SUPPORT_EVENTS,
  reconcileMessages,
  supportErrorPlan,
  TRANSIENT_ERROR_MS,
  attachmentPrecheck,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIME_TYPES,
  isPinnedToBottom,
  SCROLL_PIN_SLACK_PX,
  hasUsableContactChannel,
  supportUnreadPlan,
  SUPPORT_REPLY_ECHO_MS,
  newClientMsgId,
  type SupportEvent,
  type SupportMessageView,
} from './useSupport'

const NOW = 1_700_000_000_000

describe('contactRevealPlan', () => {
  it('reveals immediately once an OPEN thread has waited past the threshold', () => {
    const escalatedAt = new Date(NOW - CONTACT_REVEAL_MS - 60_000).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: true, delayMs: null })
  })

  it('reveals exactly at the threshold boundary', () => {
    const escalatedAt = new Date(NOW - CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: true, delayMs: null })
  })

  it('schedules a delayed reveal for an OPEN thread that has waited less than the threshold', () => {
    const waited = 60_000
    const escalatedAt = new Date(NOW - waited).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan.reveal).toBe(false)
    expect(plan.delayMs).toBe(CONTACT_REVEAL_MS - waited)
  })

  it('never reveals when escalatedAt is null, and schedules no timer', () => {
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt: null }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for an ASSIGNED thread, no matter how long ago it escalated', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'ASSIGNED', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for a RESOLVED thread', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'RESOLVED', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for a BOT thread', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'BOT', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals when there is no conversation at all', () => {
    const plan = contactRevealPlan(null, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })
})

describe('CONTACT_REVEAL_MS', () => {
  it('is 5 minutes', () => {
    expect(CONTACT_REVEAL_MS).toBe(5 * 60 * 1000)
  })
})

describe('telHref', () => {
  it('builds a tel: href from a normal phone number', () => {
    expect(telHref('+251911223344')).toBe('tel:+251911223344')
  })

  it('allows spaces, hyphens, and parentheses', () => {
    expect(telHref('(0911) 223-344')).toBe('tel:(0911) 223-344')
  })

  it('returns null for an empty string, so the template hides the channel', () => {
    expect(telHref('')).toBeNull()
  })

  it('returns null for a value that is only whitespace', () => {
    expect(telHref('   ')).toBeNull()
  })

  it('returns null rather than a usable href for a javascript: scheme', () => {
    expect(telHref('javascript:alert(1)')).toBeNull()
  })

  it('returns null for any value containing letters', () => {
    expect(telHref('call-us-now')).toBeNull()
  })
})

describe('telegramHref', () => {
  it('builds a t.me href from a handle with a leading @', () => {
    expect(telegramHref('@aradasupport')).toBe('https://t.me/aradasupport')
  })

  it('builds the same t.me href from the bare handle', () => {
    expect(telegramHref('aradasupport')).toBe('https://t.me/aradasupport')
  })

  it('returns null for an empty string, so the template hides the channel', () => {
    expect(telegramHref('')).toBeNull()
  })

  it('returns null for a bare "@" with nothing after it', () => {
    expect(telegramHref('@')).toBeNull()
  })

  it('returns null rather than a usable href for a javascript: scheme', () => {
    expect(telegramHref('javascript:alert(1)')).toBeNull()
  })

  it('returns null for a handle containing a slash, which could smuggle a different path', () => {
    expect(telegramHref('foo/../evil')).toBeNull()
  })
})

/** Minimal stand-in for the socket.io client surface `bindSupportListeners`
 *  touches, recording what is attached so a test can assert both that a fresh
 *  instance gets listeners and that re-binding doesn't stack duplicates.
 *
 *  `off` removes BY HANDLER REFERENCE, matching socket.io's real two-argument
 *  form. A fake that dropped the whole event instead would happily pass a
 *  `bindSupportListeners` that unhooks other features' listeners — exactly
 *  the bug the foreign-listener test below exists to catch. */
function fakeSocket() {
  const listeners = new Map<string, Array<(payload: any) => void>>()
  return {
    listeners,
    on(event: string, handler: (payload: any) => void) {
      const existing = listeners.get(event) ?? []
      listeners.set(event, [...existing, handler])
    },
    off(event: string, handler?: (payload: any) => void) {
      if (!handler) {
        listeners.delete(event)
        return
      }
      const remaining = (listeners.get(event) ?? []).filter((h) => h !== handler)
      if (remaining.length) listeners.set(event, remaining)
      else listeners.delete(event)
    },
    emit(event: string, payload?: any) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
  }
}

const noopHandlers = () =>
  SUPPORT_EVENTS.map((event) => [event, () => {}] as [SupportEvent, (payload: any) => void])

describe('bindSupportListeners', () => {
  it('attaches every support event to a socket it has never seen', () => {
    const socket = fakeSocket()
    bindSupportListeners(socket, noopHandlers())

    for (const event of SUPPORT_EVENTS) {
      expect(socket.listeners.get(event)).toHaveLength(1)
    }
  })

  // The regression this fix exists for: connect() hands back a NEW Socket
  // whenever the old one isn't connected, so a second openChat() binds a
  // different instance. Under the old sticky `bound` flag this socket got no
  // listeners at all, support:thread went unheard, and the widget stayed empty
  // with send() permanently blocked on its !conversation guard.
  it('binds a replacement socket after a reconnect handed back a new instance', () => {
    const first = fakeSocket()
    bindSupportListeners(first, noopHandlers())

    const reconnected = fakeSocket()
    let thread: unknown = null
    bindSupportListeners(reconnected, [
      ['support:thread', (payload) => (thread = payload)],
      ...noopHandlers().filter(([event]) => event !== 'support:thread'),
    ])

    reconnected.emit('support:thread', { conversation: { id: 'c1' }, messages: [] })
    expect(thread).toEqual({ conversation: { id: 'c1' }, messages: [] })
  })

  it('replaces rather than stacks handlers when the same socket is bound twice', () => {
    const socket = fakeSocket()
    const calls: string[] = []

    bindSupportListeners(socket, [
      ['support:message', () => calls.push('first')],
      ...noopHandlers().filter(([event]) => event !== 'support:message'),
    ])
    bindSupportListeners(socket, [
      ['support:message', () => calls.push('second')],
      ...noopHandlers().filter(([event]) => event !== 'support:message'),
    ])

    socket.emit('support:message')
    // Not ['first', 'second'] — a duplicated handler would double-count unread
    // badges and append every incoming message to the transcript twice.
    expect(calls).toEqual(['second'])
    expect(socket.listeners.get('support:message')).toHaveLength(1)
  })

  // `connect` is a shared channel: useSocket() attaches its own listener, and
  // so may any other feature on the player's single app socket. An `off(event)`
  // that clears the whole event would unhook all of them the first time support
  // rebound — killing wallet updates and reconnect logging as a side effect of
  // opening the chat panel.
  it("leaves another feature's connect listener attached when support rebinds", () => {
    const socket = fakeSocket()
    const foreign: string[] = []
    socket.on('connect', () => foreign.push('useSocket'))

    bindSupportListeners(socket, noopHandlers())
    bindSupportListeners(socket, noopHandlers())

    socket.emit('connect')
    expect(foreign).toEqual(['useSocket'])
    // One foreign listener plus exactly one of ours, never a stack of ours.
    expect(socket.listeners.get('connect')).toHaveLength(2)
  })

  // The reconnect path: rooms do not survive a reconnect, so the composable
  // re-emits support:open from its `connect` handler to rejoin the thread and
  // backfill the transcript. Binding twice must leave exactly one of those.
  it('fires its connect handler exactly once per reconnect after a rebind', () => {
    const socket = fakeSocket()
    let reopens = 0
    const withConnect = () => [
      ['connect', () => (reopens += 1)] as [SupportEvent, (payload: any) => void],
      ...noopHandlers().filter(([event]) => event !== 'connect'),
    ]

    bindSupportListeners(socket, withConnect())
    bindSupportListeners(socket, withConnect())

    socket.emit('connect')
    expect(reopens).toBe(1)
  })

  it('covers the contact-fallback and error channels, not just the happy path', () => {
    const socket = fakeSocket()
    let revealed: unknown = null
    let failure: unknown = null

    bindSupportListeners(socket, [
      ['support:contact-fallback', (payload) => (revealed = payload)],
      ['support:error', (payload) => (failure = payload)],
      ...noopHandlers().filter(
        ([event]) => event !== 'support:contact-fallback' && event !== 'support:error',
      ),
    ])

    socket.emit('support:contact-fallback', { phone: '+251900000000', telegram: '', hours: '' })
    socket.emit('support:error', { code: 'RATE_LIMIT', message: 'Slow down' })

    expect(revealed).toEqual({ phone: '+251900000000', telegram: '', hours: '' })
    expect(failure).toEqual({ code: 'RATE_LIMIT', message: 'Slow down' })
  })
})

/** Minimal SupportMessage. Only the fields the pure helpers actually read are
 *  interesting; the rest exist so the object satisfies the wire type. */
function message(over: Partial<SupportMessageView> & { id: string }): SupportMessageView {
  return {
    conversationId: 'c1',
    senderRole: 'PLAYER',
    senderId: 'u1',
    body: '',
    attachmentUrl: null,
    attachmentMime: null,
    createdAt: new Date(NOW).toISOString(),
    ...over,
  }
}

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe('reconcileMessages', () => {
  it('appends a message the client has never seen', () => {
    const merged = reconcileMessages(
      [message({ id: 'a', createdAt: at(0) })],
      [message({ id: 'b', createdAt: at(1000) })],
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('drops a duplicate broadcast of a message already in the transcript', () => {
    const existing = [message({ id: 'a', createdAt: at(0), body: 'hi' })]
    const merged = reconcileMessages(existing, [message({ id: 'a', createdAt: at(0), body: 'hi' })])
    expect(merged).toHaveLength(1)
  })

  // The core of the optimistic-echo fix: the sender is in its own conversation
  // room, so it receives the broadcast of its own message. Without matching on
  // clientMsgId the player watched their message appear twice.
  it('replaces the sender’s pending bubble with the server copy of the same message', () => {
    const pending = message({
      id: 'local:k1',
      clientMsgId: 'k1',
      sendState: 'pending',
      body: 'my card is wrong',
      createdAt: at(0),
    })
    const merged = reconcileMessages(
      [pending],
      [message({ id: 'real-1', clientMsgId: 'k1', body: 'my card is wrong', createdAt: at(5) })],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('real-1')
    // The local delivery marker must not survive: the row is committed now.
    expect(merged[0]!.sendState).toBeUndefined()
  })

  it('keeps a pending bubble that no incoming message claims', () => {
    const pending = message({ id: 'local:k1', clientMsgId: 'k1', sendState: 'pending' })
    const merged = reconcileMessages([pending], [message({ id: 'real-9', createdAt: at(10) })])
    expect(merged.map((m) => m.id)).toEqual(['local:k1', 'real-9'])
    expect(merged[0]!.sendState).toBe('pending')
  })

  // The reason support:thread merges instead of replacing: the server joins
  // the conversation room before it reads history, so a live message can beat
  // the snapshot that does not contain it.
  it('keeps a live message that arrived ahead of the transcript snapshot', () => {
    const raced = message({ id: 'live', senderRole: 'AGENT', createdAt: at(3000) })
    const snapshot = [
      message({ id: 'old-1', createdAt: at(0) }),
      message({ id: 'old-2', createdAt: at(1000) }),
    ]
    const merged = reconcileMessages([raced], snapshot)
    expect(merged.map((m) => m.id)).toEqual(['old-1', 'old-2', 'live'])
  })

  it('sorts by createdAt rather than arrival order', () => {
    const merged = reconcileMessages(
      [message({ id: 'late', createdAt: at(5000) })],
      [message({ id: 'early', createdAt: at(10) })],
    )
    expect(merged.map((m) => m.id)).toEqual(['early', 'late'])
  })

  it('keeps arrival order for messages sharing a timestamp', () => {
    const merged = reconcileMessages(
      [],
      [
        message({ id: 'first', createdAt: at(0) }),
        message({ id: 'second', createdAt: at(0) }),
        message({ id: 'third', createdAt: at(0) }),
      ],
    )
    expect(merged.map((m) => m.id)).toEqual(['first', 'second', 'third'])
  })

  it('does not mutate the array it was handed', () => {
    const existing = [message({ id: 'a', createdAt: at(0) })]
    reconcileMessages(existing, [message({ id: 'b', createdAt: at(1) })])
    expect(existing).toHaveLength(1)
  })
})

describe('supportErrorPlan', () => {
  it('clears everything when handed null', () => {
    expect(supportErrorPlan(null)).toEqual({ message: null, code: null, clearAfterMs: null })
  })

  it('keeps the code alongside the message so the banner is more than a string', () => {
    const plan = supportErrorPlan({ code: 'SUPPORT_FORBIDDEN', message: 'Not your thread' })
    expect(plan.message).toBe('Not your thread')
    expect(plan.code).toBe('SUPPORT_FORBIDDEN')
  })

  it('expires a rate-limit warning on its own', () => {
    const plan = supportErrorPlan({ code: 'SUPPORT_RATE_LIMITED', message: 'Slow down' })
    expect(plan.clearAfterMs).toBe(TRANSIENT_ERROR_MS)
  })

  it('leaves a non-transient failure on screen until something clears it', () => {
    const plan = supportErrorPlan({ code: 'SUPPORT_FAILED', message: 'Could not send' })
    expect(plan.clearAfterMs).toBeNull()
  })

  it('treats an error with no code as permanent', () => {
    const plan = supportErrorPlan({ message: 'Upload failed' })
    expect(plan).toEqual({ message: 'Upload failed', code: null, clearAfterMs: null })
  })
})

describe('attachmentPrecheck', () => {
  it('accepts an ordinary phone photo', () => {
    expect(attachmentPrecheck({ name: 'IMG_0042.jpg', size: 900_000, type: 'image/jpeg' })).toEqual(
      {
        ok: true,
      },
    )
  })

  it('rejects a file over the 5 MB server limit before any upload starts', () => {
    const result = attachmentPrecheck({
      name: 'big.png',
      size: SUPPORT_ATTACHMENT_MAX_BYTES + 1,
      type: 'image/png',
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a file exactly at the limit, which the server also accepts', () => {
    const result = attachmentPrecheck({
      name: 'edge.png',
      size: SUPPORT_ATTACHMENT_MAX_BYTES,
      type: 'image/png',
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a type outside the server allowlist', () => {
    const result = attachmentPrecheck({ name: 'receipt.pdf', size: 1000, type: 'application/pdf' })
    expect(result.ok).toBe(false)
  })

  // Several Android and iOS pickers hand back an empty `type` — most often for
  // HEIC straight out of the camera roll, which is exactly what an Ethiopian
  // player photographing a deposit slip on an iPhone produces.
  it('falls back to the extension when the picker reports no MIME type at all', () => {
    expect(attachmentPrecheck({ name: 'IMG_1.HEIC', size: 2_000_000, type: '' })).toEqual({
      ok: true,
    })
  })

  it('rejects an extension-less file the picker could not type either', () => {
    expect(attachmentPrecheck({ name: 'scan', size: 2000, type: '' }).ok).toBe(false)
  })

  it('accepts every MIME type the server allows', () => {
    for (const type of SUPPORT_ATTACHMENT_MIME_TYPES) {
      expect(attachmentPrecheck({ name: 'file', size: 1000, type }).ok).toBe(true)
    }
  })
})

describe('isPinnedToBottom', () => {
  it('is pinned when the list is scrolled to the very bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })

  it('is pinned within the slack that sub-pixel layout leaves behind', () => {
    expect(
      isPinnedToBottom({
        scrollTop: 600 - SCROLL_PIN_SLACK_PX,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  // The regression: a player who scrolled up to re-read an earlier reply was
  // yanked back down every time anything arrived.
  it('is not pinned once the player has scrolled up to read', () => {
    expect(isPinnedToBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })

  it('is pinned when the transcript is shorter than the viewport', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true)
  })
})

describe('hasUsableContactChannel', () => {
  it('is false for the empty strings a freshly seeded brand returns', () => {
    expect(hasUsableContactChannel({ phone: '', telegram: '', hours: '' })).toBe(false)
  })

  it('is false when there is no contact payload at all', () => {
    expect(hasUsableContactChannel(null)).toBe(false)
  })

  it('is true with just a phone number', () => {
    expect(hasUsableContactChannel({ phone: '+251911223344', telegram: '', hours: '' })).toBe(true)
  })

  it('is true with just a Telegram handle', () => {
    expect(hasUsableContactChannel({ phone: '', telegram: '@arada', hours: '' })).toBe(true)
  })

  // Opening hours are a caption for a channel, not a channel: a block holding
  // only these renders "Need us faster?" over nothing actionable.
  it('is false when only opening hours are configured', () => {
    expect(hasUsableContactChannel({ phone: '', telegram: '', hours: '9am-9pm' })).toBe(false)
  })

  it('is false when both values are present but neither is safe to link', () => {
    expect(
      hasUsableContactChannel({ phone: 'javascript:alert(1)', telegram: 'foo/../evil', hours: '' }),
    ).toBe(false)
  })
})

describe('supportUnreadPlan', () => {
  const closed = { isOpen: false, conversationId: 'c1', lastSocketReplyAt: null }

  it('counts an agent reply that arrives over the socket with the panel closed', () => {
    const plan = supportUnreadPlan({ kind: 'socket', conversationId: 'c1' }, closed, NOW)
    expect(plan.bump).toBe(true)
  })

  it('does not count a reply the player is already looking at', () => {
    const plan = supportUnreadPlan(
      { kind: 'socket', conversationId: 'c1' },
      { ...closed, isOpen: true },
      NOW,
    )
    expect(plan.bump).toBe(false)
  })

  // Even an uncounted socket cue has to be recorded, because it is the thing
  // the notification that follows it is an echo of.
  it('records the socket cue even when it did not count', () => {
    const plan = supportUnreadPlan(
      { kind: 'socket', conversationId: 'c1' },
      { ...closed, isOpen: true },
      NOW,
    )
    expect(plan.lastSocketReplyAt).toBe(NOW)
  })

  // The case the whole plugin exists for: the player has never opened the
  // panel, so they are in no conversation room and the notification is the
  // only cue that reaches them.
  it('counts a SUPPORT_REPLY notification when no socket cue preceded it', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c1' },
      { isOpen: false, conversationId: null, lastSocketReplyAt: null },
      NOW,
    )
    expect(plan.bump).toBe(true)
  })

  // The server now notifies on EVERY agent message, so a player who is in the
  // room gets both cues for one reply. Counting both showed 2 on the badge.
  it('drops the notification that echoes a socket cue that just landed', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c1' },
      { ...closed, lastSocketReplyAt: NOW - 200 },
      NOW,
    )
    expect(plan.bump).toBe(false)
  })

  it('counts a notification long after the last socket cue, since it is a new reply', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c1' },
      { ...closed, lastSocketReplyAt: NOW - SUPPORT_REPLY_ECHO_MS - 1 },
      NOW,
    )
    expect(plan.bump).toBe(true)
  })

  it('drops a notification for the thread the panel is open on', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c1' },
      { isOpen: true, conversationId: 'c1', lastSocketReplyAt: null },
      NOW,
    )
    expect(plan.bump).toBe(false)
  })

  it('still counts a notification for a DIFFERENT thread while the panel is open', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c2' },
      { isOpen: true, conversationId: 'c1', lastSocketReplyAt: null },
      NOW,
    )
    expect(plan.bump).toBe(true)
  })

  it('never rewrites the socket timestamp from a notification cue', () => {
    const plan = supportUnreadPlan(
      { kind: 'notification', conversationId: 'c1' },
      { ...closed, lastSocketReplyAt: NOW - 5000 },
      NOW,
    )
    expect(plan.lastSocketReplyAt).toBe(NOW - 5000)
  })
})

describe('newClientMsgId', () => {
  it('returns a different id every time, so two sends never reconcile onto each other', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClientMsgId()))
    expect(ids.size).toBe(200)
  })
})
