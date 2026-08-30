import { describe, it, expect, vi, beforeEach } from 'vitest'

// The gateway only ever imports these four support services and the
// notification service — mocking them wholesale means the real Prisma/Redis
// backed implementations never load, so no DB or Redis is needed here.
vi.mock('../services/support/support.service.js', () => ({
  SupportService: {
    ensureConversationFor: vi.fn(),
    withHistory: vi.fn(),
    getById: vi.fn(),
    assertPlayerOwns: vi.fn(),
    addMessage: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
    resolve: vi.fn(),
    escalate: vi.fn(),
    listQueue: vi.fn(),
    queueItem: vi.fn(),
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

function createFakeSocket(data: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {}
  const socket: any = {
    id: `socket-${Math.random().toString(36).slice(2)}`,
    data,
    // Most tests pass no handshake token — socket.data is pre-authenticated
    // directly, which skips the gateway's real JWT-verify branch entirely
    // (it only runs when `handshake.auth.token` is truthy). What is under
    // test in those is authorization. The token-failure branch has its own
    // describe block below, which does drive a real (unverifiable) token
    // through it.
    handshake: { auth },
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
async function setup(data: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) {
  const io = createFakeIo()
  registerSupportHandlers(io)
  const socket = createFakeSocket(data, auth)
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
    // Same reasoning: broadcastQueue asks for the changed row so clients can
    // patch it in place, and calls `.catch()` on the result.
    ;(SupportService.queueItem as any).mockResolvedValue(null)
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
    beforeEach(() => {
      ;(SupportService.getForAgent as any).mockResolvedValue({
        conversation: { id: 'conv-1', status: 'ASSIGNED' },
        messages: [],
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(2)
    })

    it('joins the conversation room BEFORE reading the transcript', async () => {
      // The other order loses messages outright: anything broadcast between
      // the read and the join is in neither the snapshot nor the room, so it
      // is never delivered at all. Joining first can only ever duplicate a
      // message, which the clients drop by id.
      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:watch']({ conversationId: 'conv-1' })

      expect(socket.join).toHaveBeenCalledWith('support:conv:conv-1')
      expect(socket.join.mock.invocationCallOrder[0]).toBeLessThan(
        (SupportService.getForAgent as any).mock.invocationCallOrder[0],
      )
    })

    it('does not mark the thread read, and does not fan a queue update out to every clerk', async () => {
      // Opening a thread to see what is waiting in it is not reading it, and
      // treating it as a read zeroed the unread badge on threads the clerk
      // had merely glanced at. It also broadcast to every clerk on shift each
      // time anyone clicked a row. support:read now owns both.
      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:watch']({ conversationId: 'conv-1' })

      expect(SupportService.markReadByAgent).not.toHaveBeenCalled()
      const queueEmits = (io.__toEmit as any).mock.calls.filter(
        ([, event]: [string, string]) => event === 'support:queue-update',
      )
      expect(queueEmits).toHaveLength(0)
    })
  })

  describe('support:read', () => {
    it('marks the thread read for a clerk and broadcasts the resulting badge change', async () => {
      // Without the broadcast, every other clerk's badge keeps the old count
      // until some unrelated event refreshes it — which is what made the read
      // protocol look like it did nothing at all.
      ;(SupportService.markReadByAgent as any).mockResolvedValue(undefined)
      ;(SupportService.unassignedCount as any).mockResolvedValue(2)

      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:read']({ conversationId: 'conv-1' })

      expect(SupportService.markReadByAgent).toHaveBeenCalledWith('conv-1')
      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:agents',
        'support:queue-update',
        expect.objectContaining({ conversationId: 'conv-1', unassignedCount: 2 }),
      )
    })

    it('marks the thread read for its owning player', async () => {
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.markReadByPlayer as any).mockResolvedValue(undefined)

      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:read']({ conversationId: 'conv-1' })

      expect(SupportService.assertPlayerOwns).toHaveBeenCalledWith('conv-1', 'player-1')
      expect(SupportService.markReadByPlayer).toHaveBeenCalledWith('conv-1')
    })
  })

  describe('support:open', () => {
    beforeEach(() => {
      ;(SupportService.ensureConversationFor as any).mockResolvedValue({ id: 'conv-1' })
      ;(SupportService.withHistory as any).mockResolvedValue({
        conversation: { id: 'conv-1', status: 'OPEN' },
        messages: [],
      })
    })

    it('joins the conversation room BEFORE reading the transcript', async () => {
      // Same gap as support:watch, and the reason ensureConversationFor exists
      // separately from openForUser: the room cannot be named until the thread
      // has an id.
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:open']()

      expect(socket.join).toHaveBeenCalledWith('support:conv:conv-1')
      expect(socket.join.mock.invocationCallOrder[0]).toBeLessThan(
        (SupportService.withHistory as any).mock.invocationCallOrder[0],
      )
      expect(socket.emit).toHaveBeenCalledWith(
        'support:thread',
        expect.objectContaining({ conversation: expect.objectContaining({ id: 'conv-1' }) }),
      )
    })

    it('does not mark the thread read — reconnecting is not reading', async () => {
      // A dropped connection re-opens the thread on its own. Treating that as
      // a read zeroed the player's unread badge for replies they never saw.
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:open']()

      expect(SupportService.markReadByPlayer).not.toHaveBeenCalled()
    })
  })

  describe('support:unwatch', () => {
    it('leaves the conversation room', async () => {
      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      socket.__handlers['support:unwatch']({ conversationId: 'conv-1' })

      expect(socket.leave).toHaveBeenCalledWith('support:conv:conv-1')
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
        message: {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderRole: 'PLAYER',
          senderId: 'player-1',
          body: 'hi',
          attachmentUrl: null,
          attachmentMime: null,
          createdAt: new Date().toISOString(),
        },
        reopened: false,
        ownerId: 'player-1',
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
        message: {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderRole: 'PLAYER',
          senderId: 'player-1',
          body: 'receipt attached',
          attachmentUrl: '/uploads/1234-abcd.png',
          attachmentMime: 'image/png',
          createdAt: new Date().toISOString(),
        },
        reopened: false,
        ownerId: 'player-1',
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

  describe('notification on an agent reply', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.addMessage as any).mockResolvedValue({
        message: {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderRole: 'AGENT',
          senderId: 'clerk-1',
          body: 'we can help with that',
          attachmentUrl: null,
          attachmentMime: null,
          createdAt: new Date().toISOString(),
        },
        reopened: false,
        ownerId: 'player-1',
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

    it('notifies the player even when they still have a connected socket', async () => {
      // This used to be gated on the player having NO connected socket, which
      // read as a sensible fallback and was exactly backwards. A player with
      // the app open but the support panel closed is in `user:<id>` and NOT
      // in the conversation room: the gate suppressed the notification while
      // the room broadcast reached nobody, so the reply simply vanished.
      // NotificationService.create emits notification:new to `user:<id>`
      // itself, so creating it unconditionally both persists the row and
      // delivers it live; the clients suppress the duplicate cue when the
      // panel is already showing the thread.
      const { socket, io } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      io.__setRoomSockets('user:player-1', [{ id: 'player-socket' }])

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'reply' })

      expect(NotificationService.create).toHaveBeenCalledWith(
        'player-1',
        'SUPPORT_REPLY',
        expect.any(String),
        'we can help with that',
        expect.objectContaining({ conversationId: 'conv-1' }),
      )
    })

    it('never notifies on a message the player sent themselves', async () => {
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'hello?' })

      expect(NotificationService.create).not.toHaveBeenCalled()
    })
  })

  describe('escalate contact fallback', () => {
    beforeEach(() => {
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.escalate as any).mockResolvedValue({
        conversation: { id: 'conv-1', userId: 'player-1', status: 'OPEN' },
        systemMessage: null,
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(1)
    })

    it('broadcasts the acknowledgement message the service wrote', async () => {
      // support:status alone changes nothing anyone can see while every
      // Phase 1 thread is already OPEN — the widget renders the same label
      // before and after. The system line is the only visible answer to the
      // button, so it has to reach the room.
      const systemMessage = {
        id: 'sys-1',
        conversationId: 'conv-1',
        senderRole: 'SYSTEM',
        senderId: null,
        body: 'passed to an agent',
        attachmentUrl: null,
        attachmentMime: null,
        createdAt: new Date().toISOString(),
      }
      ;(SupportService.escalate as any).mockResolvedValue({
        conversation: { id: 'conv-1', userId: 'player-1', status: 'OPEN' },
        systemMessage,
      })

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.__setRoomSockets('support:agents', [{ id: 'clerk-socket' }])
      await socket.__handlers['support:escalate']({ conversationId: 'conv-1' })

      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:conv:conv-1',
        'support:message',
        systemMessage,
      )
    })

    it('emits no support:message when the service wrote nothing', async () => {
      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.__setRoomSockets('support:agents', [{ id: 'clerk-socket' }])
      await socket.__handlers['support:escalate']({ conversationId: 'conv-1' })

      const messageEmits = (io.__toEmit as any).mock.calls.filter(
        ([, event]: [string, string]) => event === 'support:message',
      )
      expect(messageEmits).toHaveLength(0)
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

    it('assumes nobody is on shift when the presence read fails', async () => {
      // The two failure modes are not symmetric. Showing a phone number to a
      // player who could also have been answered in-chat costs nothing;
      // withholding it from a player nobody is going to answer is exactly
      // what this fallback exists to prevent. So a failed presence read must
      // resolve to "empty room", never to "someone is there".
      ;(SupportContact.get as any).mockResolvedValue({
        phone: '+251-911',
        telegram: '@wbingo',
        hours: '9-5',
      })

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.in = vi.fn(() => ({
        fetchSockets: async () => {
          throw new Error('redis adapter unreachable')
        },
      }))
      await socket.__handlers['support:escalate']({ conversationId: 'conv-1' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:contact-fallback',
        expect.objectContaining({ conversationId: 'conv-1', phone: '+251-911' }),
      )
    })

    it('assumes nobody is on shift when the presence read never answers', async () => {
      // fetchSockets round-trips through the Redis adapter and can hang for
      // as long as Redis is unhappy. Same asymmetry as above: the deadline
      // answers false.
      ;(SupportContact.get as any).mockResolvedValue({
        phone: '+251-911',
        telegram: '@wbingo',
        hours: '9-5',
      })

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      io.in = vi.fn(() => ({ fetchSockets: () => new Promise(() => {}) }))

      vi.useFakeTimers()
      try {
        const pending = socket.__handlers['support:escalate']({ conversationId: 'conv-1' })
        await vi.advanceTimersByTimeAsync(5000)
        await pending
      } finally {
        vi.useRealTimers()
      }

      expect(socket.emit).toHaveBeenCalledWith(
        'support:contact-fallback',
        expect.objectContaining({ conversationId: 'conv-1', phone: '+251-911' }),
      )
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

  describe('support:send acknowledgements', () => {
    // The ack is how a sender learns its message actually persisted. Without
    // it, a send that died in the rate limiter, in the attachment check or in
    // the catch block looks exactly like one still in flight, so the bubble
    // spins until the client's own 10s timeout and the player retypes
    // something that may or may not have been delivered. Every exit from the
    // handler has to call it — these cases are one per exit.

    const persisted = {
      id: 'msg-1',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'player-1',
      body: 'hi',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: new Date().toISOString(),
    }

    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.addMessage as any).mockResolvedValue({
        message: persisted,
        reopened: false,
        ownerId: 'player-1',
      })
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'OPEN',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)
    })

    it('acks ok with the persisted message on success', async () => {
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(ack).toHaveBeenCalledTimes(1)
      expect(ack).toHaveBeenCalledWith({
        ok: true,
        message: expect.objectContaining({ id: 'msg-1', clientMsgId: 'c-1' }),
      })
    })

    it('echoes clientMsgId on the broadcast so the sender replaces its own bubble', async () => {
      // The sender is in convRoom and receives its own broadcast. Without the
      // echo it cannot tell that row apart from someone else's and appends a
      // second copy of its own message.
      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        clientMsgId: 'c-1',
        body: 'hi',
      })

      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:conv:conv-1',
        'support:message',
        expect.objectContaining({ id: 'msg-1', clientMsgId: 'c-1' }),
      )
    })

    it('acks with a null clientMsgId when the sender supplied none', async () => {
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send']({ conversationId: 'conv-1', body: 'hi' }, ack)

      expect(ack).toHaveBeenCalledWith({
        ok: true,
        message: expect.objectContaining({ clientMsgId: null }),
      })
    })

    it('acks the rate-limited exit', async () => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(false)
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: 'SUPPORT_RATE_LIMITED',
        message: expect.any(String),
      })
    })

    it('acks the rejected-attachment exit', async () => {
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        {
          conversationId: 'conv-1',
          clientMsgId: 'c-1',
          body: 'hi',
          attachmentUrl: 'javascript:alert(1)',
        },
        ack,
      )

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: 'SUPPORT_BAD_ATTACHMENT',
        message: expect.any(String),
      })
      expect(SupportService.addMessage).not.toHaveBeenCalled()
    })

    it('acks the catch, carrying the service error code the client already handles', async () => {
      ;(SupportService.assertPlayerOwns as any).mockRejectedValue(new NotParticipantError())
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: 'SUPPORT_FORBIDDEN',
        message: expect.any(String),
      })
    })

    it('acks the catch with a generic code when the failure is not a service error', async () => {
      // An unexpected failure must never leak internals to a player, but it
      // must still resolve the bubble.
      ;(SupportService.addMessage as any).mockRejectedValue(new Error('connection terminated'))
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: 'SUPPORT_ERROR',
        message: 'Something went wrong',
      })
    })

    it('acks an unauthenticated send instead of leaving the sender waiting', async () => {
      const ack = vi.fn()
      const { socket } = await setup({}) // no userId

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: 'SUPPORT_UNAUTHENTICATED' }),
      )
    })

    it('never throws when the sender supplied no ack callback', async () => {
      // Both clients send acks, but the handler is called with whatever a raw
      // socket sends, and an ack is optional on the wire.
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await expect(
        socket.__handlers['support:send']({
          conversationId: 'conv-1',
          clientMsgId: 'c-1',
          body: 'hi',
        }),
      ).resolves.toBeUndefined()
    })

    it('rejects an over-length body BEFORE spending the caller a rate-limit token', async () => {
      // A broken or hostile client should not be able to burn a real
      // player's twenty-a-minute quota with payloads that were never going to
      // be stored.
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'x'.repeat(4001) },
        ack,
      )

      expect(SupportRateLimit.checkMessage).not.toHaveBeenCalled()
      expect(SupportService.addMessage).not.toHaveBeenCalled()
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: 'SUPPORT_BODY_TOO_LONG' }),
      )
    })

    it('measures the length after trimming, as addMessage does', async () => {
      // addMessage trims before storing. Measuring the raw string would
      // reject a short message padded with whitespace.
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        clientMsgId: 'c-1',
        body: ' '.repeat(5000) + 'hi' + ' '.repeat(5000),
      })

      expect(SupportService.addMessage).toHaveBeenCalled()
    })

    it('acks rather than throwing when the body is not a string at all', async () => {
      // support:send is a raw socket event: the typed clients always send a
      // string, but anyone holding a token can emit whatever they like. The
      // length guard calls .trim(), and a throw from it would escape an async
      // handler socket.io never awaits — an unhandled rejection, and a sender
      // left waiting out its own timeout for an ack that is never coming.
      ;(SupportService.addMessage as any).mockRejectedValue(
        new TypeError('body.trim is not a function'),
      )
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await expect(
        socket.__handlers['support:send'](
          { conversationId: 'conv-1', clientMsgId: 'c-1', body: 12345 },
          ack,
        ),
      ).resolves.toBeUndefined()

      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    })

    it('rejects an attachmentMime outside the upload route allowlist', async () => {
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        {
          conversationId: 'conv-1',
          clientMsgId: 'c-1',
          body: 'hi',
          attachmentUrl: '/uploads/x.svg',
          attachmentMime: 'image/svg+xml',
        },
        ack,
      )

      expect(SupportService.addMessage).not.toHaveBeenCalled()
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: 'SUPPORT_BAD_ATTACHMENT' }),
      )
    })
  })

  describe('nothing after the commit may fail the send', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.addMessage as any).mockResolvedValue({
        message: {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderRole: 'PLAYER',
          senderId: 'player-1',
          body: 'hi',
          attachmentUrl: null,
          attachmentMime: null,
          createdAt: new Date().toISOString(),
        },
        reopened: false,
        ownerId: 'player-1',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)
    })

    it('still delivers and acks the message when the follow-up status read fails', async () => {
      // The message is persisted and already on the wire by this point. A
      // slow or failing getById used to reach the catch and emit
      // SUPPORT_ERROR for a message the player could see in the transcript.
      ;(SupportService.getById as any).mockRejectedValue(new Error('statement timeout'))
      const ack = vi.fn()
      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await socket.__handlers['support:send'](
        { conversationId: 'conv-1', clientMsgId: 'c-1', body: 'hi' },
        ack,
      )

      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:conv:conv-1',
        'support:message',
        expect.objectContaining({ id: 'msg-1' }),
      )
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
      expect(socket.emit).not.toHaveBeenCalledWith('support:error', expect.anything())
    })

    it('still raises the reply notification when the follow-up status read fails', async () => {
      // The notification is the ONLY thing an offline player gets, so it must
      // not sit behind getById. It once shared a try with the status read,
      // which meant a single failing query silently reinstated the bug the
      // connected-socket gate was deleted to fix: the reply reached neither
      // the socket nor the rail. It reads the owner id out of addMessage's
      // own transaction instead.
      ;(SupportService.getById as any).mockRejectedValue(new Error('statement timeout'))
      ;(SupportService.addMessage as any).mockResolvedValue({
        message: {
          id: 'msg-2',
          conversationId: 'conv-1',
          senderRole: 'AGENT',
          senderId: 'clerk-1',
          body: 'we can help with that',
          attachmentUrl: null,
          attachmentMime: null,
          createdAt: new Date().toISOString(),
        },
        reopened: false,
        ownerId: 'player-1',
      })
      const { socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })

      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        clientMsgId: 'c-2',
        body: 'we can help with that',
      })

      expect(NotificationService.create).toHaveBeenCalledWith(
        'player-1',
        'SUPPORT_REPLY',
        'Support replied',
        'we can help with that',
        { conversationId: 'conv-1' },
      )
    })

    it('acks rather than throwing when the payload is not an object', async () => {
      // socket.io hands the handler whatever came off the wire. Destructuring
      // a null payload in the parameter list threw before any handler code
      // ran — an unhandled rejection, and no ack, so the sender waited out
      // its own 10s timeout. Any authenticated client can emit this.
      // With no conversationId to look up, the ownership check is what
      // rejects in production — mirror that rather than letting the
      // permissive mocks above wave a null payload through to a successful
      // write.
      ;(SupportService.assertPlayerOwns as any).mockRejectedValue(new NotParticipantError())
      const ack = vi.fn()
      const { socket } = await setup({ userId: 'player-1', role: 'PLAYER' })

      await expect(socket.__handlers['support:send'](null, ack)).resolves.toBeUndefined()

      expect(ack).toHaveBeenCalledTimes(1)
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    })
  })

  describe('queue broadcasts on send', () => {
    beforeEach(() => {
      ;(SupportRateLimit.checkMessage as any).mockResolvedValue(true)
      ;(SupportService.assertPlayerOwns as any).mockResolvedValue(undefined)
      ;(SupportService.getById as any).mockResolvedValue({
        id: 'conv-1',
        userId: 'player-1',
        status: 'ASSIGNED',
      })
      ;(SupportService.unassignedCount as any).mockResolvedValue(0)
    })

    const message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      senderRole: 'PLAYER',
      senderId: 'player-1',
      body: 'hi',
      attachmentUrl: null,
      attachmentMime: null,
      createdAt: new Date().toISOString(),
    }

    it('does not touch the queue for a message into a live thread', async () => {
      // A reply into a thread that was already OPEN or ASSIGNED cannot move
      // the unassigned count, and this used to fan out to every clerk on
      // shift once per message — 45 queries per message on a six-clerk shift.
      ;(SupportService.addMessage as any).mockResolvedValue({ message, reopened: false, ownerId: 'player-1' })

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        clientMsgId: 'c-1',
        body: 'hi',
      })

      expect(SupportService.unassignedCount).not.toHaveBeenCalled()
      const queueEmits = (io.__toEmit as any).mock.calls.filter(
        ([, event]: [string, string]) => event === 'support:queue-update',
      )
      expect(queueEmits).toHaveLength(0)
    })

    it('broadcasts when the message reopened a resolved thread', async () => {
      // A reopen puts the thread back in the unassigned queue, which is
      // exactly the case a clerk's badge must reflect.
      ;(SupportService.addMessage as any).mockResolvedValue({ message, reopened: true, ownerId: 'player-1' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(4)

      const { io, socket } = await setup({ userId: 'player-1', role: 'PLAYER' })
      await socket.__handlers['support:send']({
        conversationId: 'conv-1',
        clientMsgId: 'c-1',
        body: 'hi',
      })

      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:agents',
        'support:queue-update',
        expect.objectContaining({ conversationId: 'conv-1', unassignedCount: 4 }),
      )
    })

    it('carries the changed row so the inbox can patch it in place', async () => {
      const item = {
        id: 'conv-1',
        userId: 'player-1',
        username: 'abebe',
        status: 'OPEN',
        assignedToId: null,
        assignedToUsername: null,
        lastMessageAt: new Date().toISOString(),
        lastMessagePreview: 'hi',
        unreadForAgent: 1,
      }
      ;(SupportService.claim as any).mockResolvedValue({ id: 'conv-1', status: 'ASSIGNED' })
      ;(SupportService.unassignedCount as any).mockResolvedValue(1)
      ;(SupportService.queueItem as any).mockResolvedValue(item)

      const { io, socket } = await setup({ userId: 'clerk-1', role: 'CLERK' })
      await socket.__handlers['support:claim']({ conversationId: 'conv-1' })

      expect(io.__toEmit).toHaveBeenCalledWith(
        'support:agents',
        'support:queue-update',
        expect.objectContaining({ item }),
      )
    })
  })

  describe('handshake token failures', () => {
    it('tells a socket whose token failed to verify, so a dead session is not silently mute', async () => {
      // The socket is deliberately NOT disconnected: one shared `io` also
      // carries game traffic, and game.gateway.ts admits tokenless spectator
      // sockets, so ejecting on a bad token would drop players mid-game. But
      // a support client whose access token expired reconnects into a socket
      // that is connected and permanently rejected, with no way to learn why.
      const { socket } = await setup({}, { token: 'not-a-real-jwt' })

      expect(socket.emit).toHaveBeenCalledWith(
        'support:error',
        expect.objectContaining({ code: 'SUPPORT_UNAUTHENTICATED' }),
      )
    })

    it('says nothing to a connection carrying no token at all', async () => {
      // That is the anonymous game path — a spectator watching a board, not a
      // broken support session. It has no support UI to confuse, and the
      // error would surface as a banner on a page that never asked.
      const { socket } = await setup({})

      expect(socket.emit).not.toHaveBeenCalled()
    })
  })
})
