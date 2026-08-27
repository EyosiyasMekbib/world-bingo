import { describe, it, expect, vi, beforeEach } from 'vitest'

// The gateway only ever imports these four support services and the
// notification service — mocking them wholesale means the real Prisma/Redis
// backed implementations never load, so no DB or Redis is needed here.
vi.mock('../services/support/support.service.js', () => ({
  SupportService: {
    openForUser: vi.fn(),
    getById: vi.fn(),
    assertPlayerOwns: vi.fn(),
    addMessage: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
    resolve: vi.fn(),
    escalate: vi.fn(),
    listQueue: vi.fn(),
    getForAgent: vi.fn(),
    markReadByAgent: vi.fn(),
    markReadByPlayer: vi.fn(),
    unassignedCount: vi.fn(),
  },
}))

vi.mock('../services/support/support-rate-limit.js', () => ({
  SupportRateLimit: {
    checkMessage: vi.fn(),
  },
}))

vi.mock('../services/support/support-contact.js', () => ({
  SupportContact: {
    get: vi.fn(),
  },
}))

vi.mock('../services/notification.service.js', () => ({
  NotificationService: {
    create: vi.fn(),
  },
}))

// Task 14's whole point: writeSupportAudit(...) calls at the claim/release/
// resolve sites. A reviewer once deleted all three call sites and the rest
// of this suite still passed 78/78 — mocking the module and asserting on it
// directly is what makes that deletion fail a test.
vi.mock('../services/support/support-audit.js', () => ({
  writeSupportAudit: vi.fn(),
}))

import { registerSupportHandlers } from '../gateways/support.gateway.js'
import { SupportService } from '../services/support/support.service.js'
import { SupportRateLimit } from '../services/support/support-rate-limit.js'
import { SupportContact } from '../services/support/support-contact.js'
import { NotificationService } from '../services/notification.service.js'
import { writeSupportAudit } from '../services/support/support-audit.js'
// Real error classes — `fail()` branches on `instanceof SupportError`, so a
// plain mock object would not exercise that path.
import { NotParticipantError } from '../services/support/errors.js'

// ── Fake Socket.io harness ───────────────────────────────────────────────
// No real Socket.io server is started. `registerSupportHandlers` only ever
// touches `io.on`, `io.to(room).emit`, and `io.in(room).fetchSockets` on the
// `io` argument, and `socket.data/join/emit/on` on each connected socket, so
// a pair of small fakes covering exactly that surface is enough to invoke
// the registered handlers directly and inspect what they did.

function createFakeIo() {
  const connectionHandlers: Array<(socket: any) => void | Promise<void>> = []
  const roomSockets: Record<string, unknown[]> = {}
  const toEmit = vi.fn()

  const io: any = {
    on: vi.fn((event: string, handler: any) => {
      if (event === 'connection') connectionHandlers.push(handler)
    }),
    to: vi.fn((room: string) => ({
      emit: (...args: unknown[]) => toEmit(room, ...args),
    })),
    in: vi.fn((room: string) => ({
      fetchSockets: vi.fn(async () => roomSockets[room] ?? []),
    })),
    // Test-only handles, prefixed to stay out of the way of the real API.
    __toEmit: toEmit,
    __connect: async (socket: any) => {
      for (const handler of connectionHandlers) await handler(socket)
    },
    __setRoomSockets: (room: string, sockets: unknown[]) => {
      roomSockets[room] = sockets
    },
  }
  return io
}

function createFakeSocket(data: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {}
  const socket: any = {
    id: `socket-${Math.random().toString(36).slice(2)}`,
    data,
    // No handshake token in these tests — socket.data is pre-authenticated
    // directly, which skips the gateway's real JWT-verify branch entirely
    // (it only runs when `handshake.auth.token` is truthy). That branch is
    // just `jsonwebtoken` + the existing `jwtPublicKey` plumbing, already
    // exercised by game.gateway.ts; what's under test here is authorization.
    handshake: { auth: {} },
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: any) => {
      handlers[event] = handler
    }),
  }
  socket.__handlers = handlers
  return socket
}

/** Registers the gateway on a fresh fake `io`, fires `connection` with a
 *  socket carrying the given pre-authenticated `socket.data`, and returns
 *  both so a test can invoke `socket.__handlers['support:xyz'](payload)`
 *  directly and assert on `socket.emit` / `io.__toEmit` / the service mocks. */
async function setup(data: Record<string, unknown> = {}) {
  const io = createFakeIo()
  registerSupportHandlers(io)
  const socket = createFakeSocket(data)
  await io.__connect(socket)
  return { io, socket }
}

describe('support.gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: audit writes succeed. `.catch(() => {})` at each call site
    // needs something thenable to call `.catch` on, and this is the
    // production-representative default (writeSupportAudit swallows its own
    // failures) — the audit-failure-is-non-fatal test below overrides it.
    ;(writeSupportAudit as any).mockResolvedValue(undefined)
  })

  describe('authentication', () => {
    it('rejects support:send from an unauthenticated socket and never calls addMessage', async () => {
      const { socket } = await setup({}) // no userId set

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'hi' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ code: 'SUPPORT_UNAUTHENTICATED' }),
      )
      expect(SupportService.addMessage).not.toHaveBeenCalled()
    })
  })

  describe('staff-only authorization', () => {
    it('rejects support:claim from a PLAYER and never calls SupportService.claim', async () => {
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:claim']({ conversationId: 'conv-1' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ code: 'SUPPORT_FORBIDDEN' }),
      )
      expect(SupportService.claim).not.toHaveBeenCalled()
    })

    it('rejects support:watch from a PLAYER and never calls SupportService.getForAgent', async () => {
      // support:watch hands over a player's FULL message history and is
      // staff-only by design. Its siblings' guards are all tested; this one
      // wasn't.
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:watch']({ conversationId: 'conv-1' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ code: 'SUPPORT_FORBIDDEN' }),
      )
      expect(SupportService.getForAgent).not.toHaveBeenCalled()
    })
  })

  describe('support:watch', () => {
    it('broadcasts a queue update after marking the thread read, like every other staff handler', async () => {
      // markReadByAgent() clears this thread's unread count in the DB. Every
      // other staff handler (claim/release/resolve/send) calls
      // broadcastQueue() after a mutation like that; support:watch used to
      // skip it, leaving every clerk's badge stale until some unrelated
      // event happened to fire.
      ;(SupportService.getForAgent as any).mockResolvedValue({
        conversation: { id: 'conv-1', status: 'ASSIGNED' },
        messages: [],
      })
      ;(SupportService.markReadByAgent as any).mockResolvedValue(undefined)
      ;(SupportService.unassignedCount as any).mockResolvedValue(2)

      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:watch']({ conversationId: 'conv-1' })

      expect(SupportService.markReadByAgent).toHaveBeenCalledWith('conv-1')
      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:agents',
        'support:queue-update',
        expect.objectContaining({ conversationId: 'conv-1', unassignedCount: 2 }),
      )
    })
  })

  describe('ownership enforcement', () => {
    it('rejects a player sending into a conversation they do not own and writes no message', async () => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.assertPlayerOwns as any).mockRejectedValue(new NotParticipantError())

      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:send']({ conversationId: 'conv-not-mine', body: 'hi' })

      expect(SupportService.assertPlayerOwns).toHaveBeenCalledWith('conv-not-mine', 'player-1')
      expect(SupportService.addMessage).not.toHaveBeenCalled()
      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ conversationId: 'conv-not-mine', code: 'SUPPORT_FORBIDDEN' }),
      )
    })
  })

  describe('senderRole is derived from the authenticated actor, never the payload', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.addMessage as any).mockResolvedValue({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'player-1',
        body: 'hi',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date().toISOString(),
      })
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'OPEN',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)
    })

    it('stores a player message as senderRole PLAYER with the caller as senderId', async () => {
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'hi' })

      expect(SupportService.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderRole: 'PLAYER', senderId: 'player-1' }),
      )
    })

    it('ignores a player-supplied senderRole field and still stores PLAYER', async () => {
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      // A raw socket payload is attacker-controlled JSON, not the typed
      // ClientToServerEvents shape — nothing stops a malicious client from
      // adding fields the TS type does not declare.
      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        body: 'hi',
        senderRole: 'AGENT',
        senderId: 'someone-else',
      } as any)

      expect(SupportService.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderRole: 'PLAYER', senderId: 'player-1' }),
      )
    })

    it('stores a CLERK message as senderRole AGENT and skips the ownership check', async () => {
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'ASSIGNED',
      })
      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      io.__setRoomSockets('user:player-1', [{ id: 'player-socket' }])

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'reply' })

      expect(SupportService.assertPlayerOwns).not.toHaveBeenCalled()
      expect(SupportService.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderRole: 'AGENT', senderId: 'clerk-1' }),
      )
    })
  })

  describe('rate limiting', () => {
    it('rejects with SUPPORT_RATE_LIMITED and writes no message when the limiter denies', async () => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(false)

      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'hi' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ conversationId: 'conv-1', code: 'SUPPORT_RATE_LIMITED' }),
      )
      expect(SupportService.addMessage).not.toHaveBeenCalled()
    })
  })

  describe('attachmentUrl validation', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
    })

    it('rejects a javascript: attachmentUrl with SUPPORT_BAD_ATTACHMENT and never calls addMessage', async () => {
      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })

      // attachmentUrl arrives on the raw socket payload — nothing forces the
      // client to have gone through the upload route. The admin inbox
      // renders it into an <a href>, so this must be rejected before the
      // message is ever persisted or broadcast.
      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        body: 'hi',
        attachmentUrl: 'javascript:alert(1)',
      })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ conversationId: 'conv-1', code: 'SUPPORT_BAD_ATTACHMENT' }),
      )
      expect(SupportService.addMessage).not.toHaveBeenCalled()
    })

    it('rejects javascript:/uploads/x.png — the string that defeats naive prefix matching', async () => {
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)

      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        body: 'hi',
        attachmentUrl: 'javascript:/uploads/x.png',
      })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ conversationId: 'conv-1', code: 'SUPPORT_BAD_ATTACHMENT' }),
      )
      expect(SupportService.addMessage).not.toHaveBeenCalled()
    })

    it('allows a real /uploads/ attachmentUrl through to addMessage', async () => {
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.addMessage as any).mockResolvedValue({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'PLAYER',
        senderId: 'player-1',
        body: 'receipt attached',
        attachmentUrl: '/uploads/1234-abcd.png',
        attachmentMime: 'image/png',
        createdAt: new Date().toISOString(),
      })
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'OPEN',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        body: 'receipt attached',
        attachmentUrl: '/uploads/1234-abcd.png',
        attachmentMime: 'image/png',
      })

      expect(SupportService.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentUrl: '/uploads/1234-abcd.png' }),
      )
    })
  })

  describe('offline notification on an agent reply', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.addMessage as any).mockResolvedValue({
        id: 'msg-1',
        conversationId: 'conv-1',
        senderRole: 'AGENT',
        senderId: 'clerk-1',
        body: 'we can help with that',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date().toISOString(),
      })
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'ASSIGNED',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)
    })

    it('notifies the player when they have no connected socket', async () => {
      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      io.__setRoomSockets('user:player-1', [])

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'reply' })

      expect(NotificationService.create).toHaveBeenCalledWith(
        'player-1',
        'SUPPORT_REPLY',
        expect.any(String),
        'we can help with that',
        expect.objectContaining({ conversationId: 'conv-1' }),
      )
    })

    it('does not notify the player when they still have a connected socket', async () => {
      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      io.__setRoomSockets('user:player-1', [{ id: 'player-socket' }])

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'reply' })

      expect(NotificationService.create).not.toHaveBeenCalled()
    })
  })

  describe('escalate contact fallback', () => {
    beforeEach(() => {
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.escalate as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'OPEN',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(1)
    })

    // Presence is read from live room membership, not a Redis set, so these
    // two drive the agents room directly. An empty room is the state a
    // deploy used to be unable to reach: the old set kept every clerk marked
    // online after shutdown skipped their disconnect handlers, so the
    // fallback stopped firing for good.
    it('emits support:contact-fallback when the agents room is empty', async () => {
      ;(SupportContact.get as any).mockResolvedValue({
        phone: '+251-911',
        telegram: '@wbingo',
        hours: '9-5',
      })

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.__setRoomSockets('support:agents', [])
      await socket.__handlers['support:escalate']({ conversationId: 'conv-1' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:contact-fallback',
        expect.objectContaining({ conversationId: 'conv-1', phone: '+251-911' }),
      )
    })

    it('does not emit support:contact-fallback when a clerk is in the agents room', async () => {
      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.__setRoomSockets('support:agents', [{ id: 'clerk-socket', data: { userId: 'clerk-1' } }])
      await socket.__handlers['support:escalate']({ conversationId: 'conv-1' })

      const fallbackCalls = (socket.emit as any).mock.calls.filter(
        ([event]: [string]) => event === 'support:contact-fallback',
      )
      expect(fallbackCalls).toHaveLength(0)
      expect(SupportContact.get).not.toHaveBeenCalled()
    })
  })

  describe('force powers are ADMIN/SUPER_ADMIN only', () => {
    it('releases as isAdmin=false for a CLERK and isAdmin=true for an ADMIN', async () => {
      ;(SupportService.release as any).mockResolvedValue({ id: 'conv-1', status: 'OPEN' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket: clerkSocket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await clerkSocket.__handlers['support:release']({ conversationId: 'conv-1' })
      expect(SupportService.release).toHaveBeenLastCalledWith('conv-1', 'clerk-1', false)

      const { socket: adminSocket } = await setup({ userId: 'admin-1', role: 'ADMIN' })
      await adminSocket.__handlers['support:release']({ conversationId: 'conv-1' })
      expect(SupportService.release).toHaveBeenLastCalledWith('conv-1', 'admin-1', true)
    })
  })

  describe('audit trail (Task 14)', () => {
    // Deleting a `writeSupportAudit(...)` call site must fail one of these —
    // that is the entire reason this describe block exists. See the manual
    // "delete the call sites, confirm this suite goes red" check documented
    // in the phase-1 final-fixes report.

    it('writes a support.claim audit row with the conversation id on a successful claim', async () => {
      ;(SupportService.claim as any).mockResolvedValue({ id: 'conv-1', status: 'ASSIGNED' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:claim']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).toHaveBeenCalledWith('clerk-1', 'support.claim', 'conv-1')
    })

    it('writes a support.release audit row with detail {forced:false} for a CLERK', async () => {
      ;(SupportService.release as any).mockResolvedValue({ id: 'conv-1', status: 'OPEN' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:release']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).toHaveBeenCalledWith('clerk-1', 'support.release', 'conv-1', {
        forced: false,
      })
    })

    it('writes a support.release audit row with detail {forced:true} for an ADMIN', async () => {
      ;(SupportService.release as any).mockResolvedValue({ id: 'conv-1', status: 'OPEN' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket } = await setup({ userId: 'admin-1', role: 'ADMIN' })
      await socket.__handlers['support:release']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).toHaveBeenCalledWith('admin-1', 'support.release', 'conv-1', {
        forced: true,
      })
    })

    it('writes a support.resolve audit row with the conversation id on a successful resolve', async () => {
      ;(SupportService.resolve as any).mockResolvedValue({ id: 'conv-1', status: 'RESOLVED' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)

      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:resolve']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).toHaveBeenCalledWith('clerk-1', 'support.resolve', 'conv-1')
    })

    it('writes no audit row when the service call throws — a rejected claim is never recorded as if it happened', async () => {
      ;(SupportService.claim as any).mockRejectedValue(new Error('cartela already claimed'))

      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:claim']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).not.toHaveBeenCalled()
      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ conversationId: 'conv-1' }),
      )
    })

    it('writes no audit row when a conditional update matches nothing (release rejected)', async () => {
      // Modelled on the service throwing when its conditional WHERE matches
      // zero rows — e.g. someone else already released/claimed it.
      ;(SupportService.release as any).mockRejectedValue(new Error('not currently assigned'))

      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:release']({ conversationId: 'conv-1' })

      expect(writeSupportAudit).not.toHaveBeenCalled()
    })

    it('an audit write failure does not break the action: success events still fire and no support:error is emitted', async () => {
      ;(SupportService.claim as any).mockResolvedValue({ id: 'conv-1', status: 'ASSIGNED' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(3)
      ;(writeSupportAudit as any).mockRejectedValue(new Error('audit db unreachable'))

      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:claim']({ conversationId: 'conv-1' })

      // The claim itself still succeeded and broadcast normally...
      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:conv:conv-1',
        'support:status',
        expect.objectContaining({ id: 'conv-1' }),
      )
      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:agents',
        'support:queue-update',
        expect.objectContaining({ unassignedCount: 3 }),
      )
      // ...and the caller never sees an error for a purely internal audit
      // failure — a broken audit log must not read as a broken claim.
      expect(socket.emit).not.toHaveBeenCalledWith('support:error', expect.anything())
    })
  })
})
