import { describe, it, expect } from 'vitest'
import {
  contactRevealPlan,
  CONTACT_REVEAL_MS,
  telHref,
  telegramHref,
  bindSupportListeners,
  SUPPORT_EVENTS,
  type SupportEvent,
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
