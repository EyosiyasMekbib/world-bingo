import { Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '@world-bingo/shared-types'
import { jwtPublicKey } from '../lib/jwt-keys.js'
import { SupportService } from '../services/support/support.service.js'
import { SupportPresence } from '../services/support/support-presence.js'
import { SupportRateLimit } from '../services/support/support-rate-limit.js'
import { SupportContact } from '../services/support/support-contact.js'
import { SupportError } from '../services/support/errors.js'
import { NotificationService } from '../services/notification.service.js'

type SupportSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

const AGENTS_ROOM = 'support:agents'
const STAFF_ROLES = new Set(['CLERK', 'ADMIN', 'SUPER_ADMIN'])
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])

const convRoom = (conversationId: string) => `support:conv:${conversationId}`

export function registerSupportHandlers(io: any) {
  /** Every support event needs a real identity — unlike the game gateway,
   *  which tolerates anonymous spectators. */
  function actor(socket: SupportSocket): { userId: string; role: string } | null {
    const userId = socket.data?.userId
    if (!userId) {
      socket.emit('support:error', {
        code: 'SUPPORT_UNAUTHENTICATED',
        message: 'Sign in to use support chat',
      })
      return null
    }
    return { userId, role: socket.data.role ?? 'PLAYER' }
  }

  function staffActor(socket: SupportSocket): { userId: string; role: string } | null {
    const who = actor(socket)
    if (!who) return null
    if (!STAFF_ROLES.has(who.role)) {
      socket.emit('support:error', {
        code: 'SUPPORT_FORBIDDEN',
        message: 'Staff only',
      })
      return null
    }
    return who
  }

  /** Service errors carry a client-safe code; anything else is a bug and
   *  becomes a generic message so internals never reach a player. */
  function fail(socket: SupportSocket, conversationId: string | undefined, err: unknown) {
    if (err instanceof SupportError) {
      socket.emit('support:error', { conversationId, code: err.code, message: err.message })
      return
    }
    console.error('[support.gateway]', err)
    socket.emit('support:error', {
      conversationId,
      code: 'SUPPORT_ERROR',
      message: 'Something went wrong',
    })
  }

  async function broadcastQueue(conversationId: string) {
    const unassignedCount = await SupportService.unassignedCount()
    io.to(AGENTS_ROOM).emit('support:queue-update', { conversationId, unassignedCount })
  }

  io.on('connection', async (socket: SupportSocket) => {
    // The game gateway already decodes this token, but gateway registration
    // order is not guaranteed, so decode independently rather than depending
    // on another handler having run first.
    const token = socket.handshake.auth?.token
    if (token) {
      try {
        // The access token carries only { id, role } — see
        // controllers/auth.controller.ts. There is no username claim, so
        // anything needing a display name resolves it from the database.
        const user = jwt.verify(token, jwtPublicKey, { algorithms: ['RS256'] }) as {
          id: string
          role: string
        }
        socket.data.userId = user.id
        socket.data.role = user.role
      } catch {
        // Leave socket.data empty; every support handler rejects it.
      }
    }

    const isStaff = STAFF_ROLES.has(socket.data?.role ?? '')
    if (isStaff && socket.data.userId) {
      socket.join(AGENTS_ROOM)
      await SupportPresence.markOnline(socket.data.userId)
    }

    // ── Player: open or create the live thread ───────────────────────────
    socket.on('support:open', async () => {
      const who = actor(socket)
      if (!who) return
      try {
        const thread = await SupportService.openForUser(who.userId)
        socket.join(convRoom(thread.conversation.id))
        await SupportService.markReadByPlayer(thread.conversation.id)
        socket.emit('support:thread', thread)
      } catch (err) {
        fail(socket, undefined, err)
      }
    })

    // ── Staff: watch a thread from the inbox ─────────────────────────────
    socket.on('support:watch', async ({ conversationId }) => {
      const who = staffActor(socket)
      if (!who) return
      try {
        const thread = await SupportService.getForAgent(conversationId)
        socket.join(convRoom(conversationId))
        await SupportService.markReadByAgent(conversationId)
        socket.emit('support:thread', thread)
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    // ── Either side: send a message ──────────────────────────────────────
    socket.on('support:send', async ({ conversationId, body, attachmentUrl, attachmentMime }) => {
      const who = actor(socket)
      if (!who) return

      try {
        const allowed = await SupportRateLimit.checkMessage(who.userId)
        if (!allowed) {
          socket.emit('support:error', {
            conversationId,
            code: 'SUPPORT_RATE_LIMITED',
            message: 'Too many messages. Wait a moment.',
          })
          return
        }

        const staff = STAFF_ROLES.has(who.role)
        if (!staff) await SupportService.assertPlayerOwns(conversationId, who.userId)

        const message = await SupportService.addMessage({
          conversationId,
          senderRole: staff ? 'AGENT' : 'PLAYER',
          senderId: who.userId,
          body,
          attachmentUrl,
          attachmentMime,
        })

        io.to(convRoom(conversationId)).emit('support:message', message)

        const conversation = await SupportService.getById(conversationId)
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        await broadcastQueue(conversationId)

        if (staff) {
          // A reply nobody is connected to read is a reply that
          // disappears. Push it into the existing notification rail.
          const listeners = await io.in(`user:${conversation.userId}`).fetchSockets()
          if (listeners.length === 0) {
            await NotificationService.create(
              conversation.userId,
              'SUPPORT_REPLY' as never,
              'Support replied',
              message.body.slice(0, 140),
              { conversationId },
            )
          }
        }
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    // ── Player: ask for a human ──────────────────────────────────────────
    socket.on('support:escalate', async ({ conversationId }) => {
      const who = actor(socket)
      if (!who) return
      try {
        await SupportService.assertPlayerOwns(conversationId, who.userId)
        const conversation = await SupportService.escalate(conversationId)
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        await broadcastQueue(conversationId)

        // Escalating into an empty room must hand over a phone number,
        // not silence.
        if (!(await SupportPresence.anyOnline())) {
          const contact = await SupportContact.get()
          socket.emit('support:contact-fallback', { conversationId, ...contact })
        }
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    // ── Staff: claim, release, resolve ───────────────────────────────────
    socket.on('support:claim', async ({ conversationId }) => {
      const who = staffActor(socket)
      if (!who) return
      try {
        const conversation = await SupportService.claim(conversationId, who.userId)
        socket.join(convRoom(conversationId))
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        await broadcastQueue(conversationId)
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    socket.on('support:release', async ({ conversationId }) => {
      const who = staffActor(socket)
      if (!who) return
      try {
        const conversation = await SupportService.release(
          conversationId,
          who.userId,
          ADMIN_ROLES.has(who.role),
        )
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        await broadcastQueue(conversationId)
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    socket.on('support:resolve', async ({ conversationId }) => {
      const who = staffActor(socket)
      if (!who) return
      try {
        const conversation = await SupportService.resolve(
          conversationId,
          who.userId,
          ADMIN_ROLES.has(who.role),
        )
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        await broadcastQueue(conversationId)
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    socket.on('support:read', async ({ conversationId }) => {
      const who = actor(socket)
      if (!who) return
      try {
        if (STAFF_ROLES.has(who.role)) {
          await SupportService.markReadByAgent(conversationId)
        } else {
          await SupportService.assertPlayerOwns(conversationId, who.userId)
          await SupportService.markReadByPlayer(conversationId)
        }
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    socket.on('disconnect', async () => {
      if (!isStaff || !socket.data.userId) return
      // A clerk with two tabs open is still on shift. Only clear presence
      // when this was their last socket.
      const remaining = await io.in(AGENTS_ROOM).fetchSockets()
      const stillConnected = remaining.some(
        (s: { id: string; data?: { userId?: string } }) =>
          s.data?.userId === socket.data.userId && s.id !== socket.id,
      )
      if (!stillConnected) await SupportPresence.markOffline(socket.data.userId)
    })
  })
}
