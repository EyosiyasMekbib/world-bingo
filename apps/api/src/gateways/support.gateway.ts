import { Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  NotificationType,
} from '@world-bingo/shared-types'
import { jwtPublicKey } from '../lib/jwt-keys.js'
import { SupportService } from '../services/support/support.service.js'
import { SupportRateLimit } from '../services/support/support-rate-limit.js'
import { SupportContact } from '../services/support/support-contact.js'
import { SupportError } from '../services/support/errors.js'
import { NotificationService } from '../services/notification.service.js'
import { isSafeAttachmentUrl } from '../services/support/attachment-url.js'
import { writeSupportAudit } from '../services/support/support-audit.js'

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

  /**
   * Whether any clerk is actually on shift, anywhere in the cluster.
   *
   * Derived from live room membership rather than a Redis set of agent ids.
   * The set was written on connect and cleared in a `disconnect` handler, so
   * it only stayed truthful when every socket closed cleanly — and it did not.
   * `shutdown()` calls `process.exit(0)` as soon as `server.close()` resolves,
   * which does not wait for each disconnect handler's async Redis write, so a
   * routine deploy left every clerk marked online forever. `anyOnline()` then
   * answered true with nobody there, and the escalation fallback — the one
   * thing that hands a stranded player a phone number — silently never fired
   * again. A crashed or OOM-killed instance left the same residue permanently.
   *
   * `fetchSockets()` goes through the Redis adapter (lib/socket.ts), so it
   * sees agents on every instance, and it cannot go stale: it reports the
   * connections that exist right now. Same call the reply-notification
   * fallback below already relies on.
   */
  async function anyAgentOnline(): Promise<boolean> {
    const agents = await io.in(AGENTS_ROOM).fetchSockets()
    return agents.length > 0
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

    // Membership of this room is now the whole record of who is on shift —
    // see anyAgentOnline() above. Nothing to clear on disconnect: socket.io
    // removes a closed socket from its rooms itself, on every instance,
    // whether it closed cleanly, crashed, or was killed mid-deploy.
    if (STAFF_ROLES.has(socket.data?.role ?? '') && socket.data.userId) {
      socket.join(AGENTS_ROOM)
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
        // markReadByAgent just cleared this thread's unread count in the DB —
        // every other staff handler broadcasts the queue after a mutation
        // like this; without it every clerk's badge stays stale until some
        // unrelated event fires.
        await broadcastQueue(conversationId)
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

        // attachmentUrl arrives on the raw socket payload. Nothing forces a
        // client to have used the upload route — anyone who can open a socket
        // can emit support:send with an arbitrary string. The admin inbox
        // renders it into an <a href>, so a `javascript:` value would execute
        // in a CLERK's authenticated session on click. Validate server-side:
        // the client-side guard is defence in depth, this is the real fix.
        if (attachmentUrl && !isSafeAttachmentUrl(attachmentUrl)) {
          socket.emit('support:error', {
            conversationId,
            code: 'SUPPORT_BAD_ATTACHMENT',
            message: 'Attachment rejected',
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
              NotificationType.SUPPORT_REPLY,
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
        if (!(await anyAgentOnline())) {
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
        // writeSupportAudit already swallows its own failures (see
        // support-audit.ts) so this never rejects in production — but that
        // guarantee lives in a module this call site doesn't control, so
        // `.catch()` here too: an audit write must never be able to turn a
        // successful claim into a SUPPORT_ERROR for the caller.
        await writeSupportAudit(who.userId, 'support.claim', conversationId).catch(() => {})
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
        // Hoisted so the service call and the audit detail provably see the
        // same value — two separate `ADMIN_ROLES.has(who.role)` calls can
        // never disagree, but they also can't be *proven* to agree by
        // reading the code, since `who.role` doesn't change between them.
        const isAdmin = ADMIN_ROLES.has(who.role)
        const conversation = await SupportService.release(conversationId, who.userId, isAdmin)
        await writeSupportAudit(who.userId, 'support.release', conversationId, {
          forced: isAdmin,
        }).catch(() => {})
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
        await writeSupportAudit(who.userId, 'support.resolve', conversationId).catch(() => {})
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
  })
}
