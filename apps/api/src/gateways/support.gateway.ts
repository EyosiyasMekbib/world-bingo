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
import { ALLOWED_MIME_TYPES } from '../lib/storage.js'

type SupportSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

const AGENTS_ROOM = 'support:agents'
const STAFF_ROLES = new Set(['CLERK', 'ADMIN', 'SUPER_ADMIN'])
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])

/** Generous for support — the longest real message anyone has sent is a wall
 *  of transaction ids — but small enough that a broken or hostile client
 *  cannot post a megabyte into the inbox. */
const MAX_BODY_CHARS = 4000

/** How long to wait for the cluster-wide agent presence read before assuming
 *  nobody is on shift. */
const AGENT_PRESENCE_TIMEOUT_MS = 2000

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
   *  becomes a generic message so internals never reach a player.
   *
   *  Returns what it emitted so an acknowledged event can hand the sender the
   *  same code over its ack callback without a second copy of this branching
   *  living at the call site. Callers with no ack ignore the return. */
  function fail(
    socket: SupportSocket,
    conversationId: string | undefined,
    err: unknown,
  ): { code: string; message: string } {
    if (err instanceof SupportError) {
      socket.emit('support:error', { conversationId, code: err.code, message: err.message })
      return { code: err.code, message: err.message }
    }
    console.error('[support.gateway]', err)
    const generic = { code: 'SUPPORT_ERROR', message: 'Something went wrong' }
    socket.emit('support:error', { conversationId, ...generic })
    return generic
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
   * connections that exist right now. Call it through
   * `anyAgentOnlineWithin` — never directly — so a slow adapter cannot hold
   * up the caller.
   */
  async function anyAgentOnline(): Promise<boolean> {
    const agents = await io.in(AGENTS_ROOM).fetchSockets()
    return agents.length > 0
  }

  /**
   * anyAgentOnline() with a deadline, and the deadline answers `false`.
   *
   * fetchSockets() round-trips through the Redis adapter, so it can hang for
   * as long as Redis is unhappy. The only caller is the escalation fallback,
   * and its two failure modes are not symmetric: showing a phone number to a
   * player who could also have been answered in-chat costs nothing, while
   * withholding it from a player nobody is going to answer is precisely the
   * failure this fallback exists to prevent. So a timeout means "assume the
   * room is empty", never "assume someone is there".
   */
  async function anyAgentOnlineWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        anyAgentOnline(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms)
        }),
      ])
    } catch (err) {
      console.error('[support.gateway] agent presence read failed', err)
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function broadcastQueue(conversationId: string) {
    // The changed row rides along so the inbox can patch it in place. Without
    // it every clerk answers a queue-update by refetching the entire queue
    // over HTTP, and clerks behind one office NAT share a single
    // 100-request-per-minute budget.
    const [unassignedCount, item] = await Promise.all([
      SupportService.unassignedCount(),
      SupportService.queueItem(conversationId).catch(() => null),
    ])
    io.to(AGENTS_ROOM).emit('support:queue-update', {
      conversationId,
      unassignedCount,
      item: item ?? undefined,
    })
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
        //
        // The socket is NOT disconnected here, and no io.use() middleware
        // rejects the handshake: there is one shared `io` and game.gateway.ts
        // deliberately admits tokenless spectator sockets, so ejecting on a
        // bad token would drop players mid-game for a support concern.
        //
        // But a support client whose access token expired mid-session
        // reconnects into a socket that is connected and permanently mute —
        // every event it sends is silently rejected and it has no way to
        // learn why. Tell that socket, and only that socket. A connection
        // carrying no token at all gets nothing: that is the anonymous game
        // path, not a broken session, and it has no support UI to confuse.
        socket.emit('support:error', {
          code: 'SUPPORT_UNAUTHENTICATED',
          message: 'Your session expired. Sign in again to use support chat.',
        })
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
        // Join BEFORE reading the transcript. The two steps used to be the
        // other way round, and anything broadcast in the gap — a clerk's
        // reply landing while the player's panel was opening — was in
        // neither the snapshot nor the room, so it was never delivered at
        // all. Joining first can only ever duplicate a message, which the
        // clients dedupe by id.
        const conversation = await SupportService.ensureConversationFor(who.userId)
        socket.join(convRoom(conversation.id))
        // No markReadByPlayer here: reconnecting is not reading. The client
        // emits support:read when the panel is actually open.
        socket.emit('support:thread', await SupportService.withHistory(conversation))
      } catch (err) {
        fail(socket, undefined, err)
      }
    })

    // ── Staff: watch a thread from the inbox ─────────────────────────────
    socket.on('support:watch', async ({ conversationId }) => {
      const who = staffActor(socket)
      if (!who) return
      try {
        // Same ordering as support:open, for the same reason.
        socket.join(convRoom(conversationId))
        // No markReadByAgent here either — a clerk clicking through the
        // queue to see what is waiting has not read any of it. support:read
        // is what marks a thread read, and it is what broadcasts the
        // resulting badge change.
        socket.emit('support:thread', await SupportService.getForAgent(conversationId))
      } catch (err) {
        fail(socket, conversationId, err)
      }
    })

    // ── Staff: stop watching a thread ────────────────────────────────────
    socket.on('support:unwatch', ({ conversationId }) => {
      // No guard and no error path: socket.leave only ever affects the
      // caller's own socket, leaving a room you are not in is a no-op, and a
      // clerk clicking away from a thread must never be shown an error.
      socket.leave(convRoom(conversationId))
    })

    // ── Either side: send a message ──────────────────────────────────────
    socket.on(
      'support:send',
      async (payload, ack) => {
        // Destructured in the BODY, not the parameter list. socket.io hands
        // this handler whatever came off the wire, and a payload of `null` or
        // a number throws on a destructuring parameter — before any line of
        // this handler runs, so before `ack` can be called and outside the
        // try below. That is an unhandled rejection plus a sender left waiting
        // out its own timeout: the two outcomes this handler exists to rule
        // out. The body-shape guards inside the try already cover a malformed
        // `body`; this covers a malformed payload.
        const { conversationId, clientMsgId, body, attachmentUrl, attachmentMime } =
          (payload ?? {}) as Partial<{
            conversationId: string
            clientMsgId: string
            body: string
            attachmentUrl: string
            attachmentMime: string
          }>
        /**
         * Every path out of this handler calls `ack` exactly once.
         *
         * Without it a sender can only ever hope: a message that died in the
         * rate limiter, in the attachment check or in the catch block looks
         * identical to one still in flight, so the client leaves the bubble
         * spinning until its own timeout and the player retypes something
         * that may or may not have been delivered. `support:error` is still
         * emitted alongside, because the admin's global banner reads it.
         */
        const reject = (code: string, message: string) => {
          socket.emit('support:error', { conversationId, code, message })
          ack?.({ ok: false, code, message })
        }

        const who = actor(socket)
        if (!who) {
          ack?.({
            ok: false,
            code: 'SUPPORT_UNAUTHENTICATED',
            message: 'Sign in to use support chat',
          })
          return
        }

        const staff = STAFF_ROLES.has(who.role)
        let message: Awaited<ReturnType<typeof SupportService.addMessage>>['message']
        let reopened: boolean
        let ownerId: string

        try {
          // Checked before the rate limiter so a payload that was never going
          // to be stored cannot burn the caller's twenty-a-minute quota. The
          // cap is on the TRIMMED length because addMessage trims before
          // storing: measuring the raw string would reject a message for
          // whitespace that is about to be discarded anyway.
          //
          // Inside the try, not above it: `body` is whatever a raw socket
          // sent, and calling .trim() on a number or an object throws. Above
          // the try that throw escapes an async handler socket.io does not
          // await — an unhandled rejection, and an ack the sender never
          // receives, which is the one outcome this handler exists to rule
          // out.
          if ((typeof body === 'string' ? body.trim().length : 0) > MAX_BODY_CHARS) {
            reject(
              'SUPPORT_BODY_TOO_LONG',
              `Message is too long (max ${MAX_BODY_CHARS} characters)`,
            )
            return
          }

          const allowed = await SupportRateLimit.checkMessage(who.userId)
          if (!allowed) {
            reject('SUPPORT_RATE_LIMITED', 'Too many messages. Wait a moment.')
            return
          }

          // attachmentUrl arrives on the raw socket payload. Nothing forces a
          // client to have used the upload route — anyone who can open a socket
          // can emit support:send with an arbitrary string. The admin inbox
          // renders it into an <a href>, so a `javascript:` value would execute
          // in a CLERK's authenticated session on click. Validate server-side:
          // the client-side guard is defence in depth, this is the real fix.
          if (attachmentUrl && !isSafeAttachmentUrl(attachmentUrl)) {
            reject('SUPPORT_BAD_ATTACHMENT', 'Attachment rejected')
            return
          }

          // Same reasoning for the declared MIME type, which the inbox uses
          // to decide whether to render the attachment inline. Checked
          // against the upload route's own allowlist rather than a copy, so
          // the two cannot drift.
          if (attachmentMime && !ALLOWED_MIME_TYPES.includes(attachmentMime)) {
            reject('SUPPORT_BAD_ATTACHMENT', 'Attachment rejected')
            return
          }

          if (!staff) await SupportService.assertPlayerOwns(conversationId, who.userId)

          const result = await SupportService.addMessage({
            conversationId,
            senderRole: staff ? 'AGENT' : 'PLAYER',
            senderId: who.userId,
            body,
            attachmentUrl,
            attachmentMime,
          })
          reopened = result.reopened
          ownerId = result.ownerId
          // The sender's own id rides back on the broadcast so it can replace
          // its optimistic bubble instead of appending a second copy of it —
          // the sender is in convRoom and receives its own broadcast.
          message = { ...result.message, clientMsgId: clientMsgId ?? null }

          io.to(convRoom(conversationId)).emit('support:message', message)
          ack?.({ ok: true, message })
        } catch (err) {
          const { code, message: text } = fail(socket, conversationId, err)
          ack?.({ ok: false, code, message: text })
          return
        }

        // ── Past the commit ────────────────────────────────────────────
        // The message is persisted and already on the wire. Everything below
        // is bookkeeping around it, and none of it may turn a delivered
        // message into a failure the sender sees — a slow status read or a
        // notification-rail hiccup used to reach the catch above and emit
        // SUPPORT_ERROR for a message the player could see in the transcript.
        if (staff) {
          // Unconditional. This used to be gated on the player having no
          // connected socket, which read as a sensible fallback and was
          // exactly backwards: a player with the app open but the panel
          // closed is in `user:<id>` and not in the conversation room, so
          // the gate suppressed the notification while the broadcast
          // reached nobody, and the reply simply vanished.
          // NotificationService.create emits notification:new to
          // `user:<id>` itself, so this both persists the row and delivers
          // it live. The cost is one duplicate cue for a player who is
          // looking at the panel, which the clients suppress locally.
          //
          // First past the commit, in its own try, and keyed on the ownerId
          // addMessage already read inside its transaction — NOT on a
          // `getById` below. Sharing a try with the status read put the one
          // delivery guarantee an offline player has behind a call that is
          // explicitly allowed to fail, which would have quietly reinstated
          // the very bug the gate above was deleted to fix.
          try {
            await NotificationService.create(
              ownerId,
              NotificationType.SUPPORT_REPLY,
              'Support replied',
              message.body.slice(0, 140),
              { conversationId },
            )
          } catch (err) {
            console.error('[support.gateway] post-commit notification', err)
          }
        }

        try {
          const conversation = await SupportService.getById(conversationId)
          io.to(convRoom(conversationId)).emit('support:status', conversation)

          // Only a reopen can move the unassigned count: a reply into a
          // thread that was already OPEN or ASSIGNED leaves every clerk's
          // badge exactly where it was, and this fans out to every clerk on
          // shift once per message.
          if (reopened) await broadcastQueue(conversationId)
        } catch (err) {
          console.error('[support.gateway] post-commit', err)
        }
      },
    )

    // ── Player: ask for a human ──────────────────────────────────────────
    socket.on('support:escalate', async ({ conversationId }) => {
      const who = actor(socket)
      if (!who) return

      try {
        await SupportService.assertPlayerOwns(conversationId, who.userId)
        const { conversation, systemMessage } = await SupportService.escalate(conversationId)
        io.to(convRoom(conversationId)).emit('support:status', conversation)
        // The status line alone changes nothing a player can see while every
        // Phase 1 thread is already OPEN. The acknowledgement is the only
        // visible answer to the button, so it has to reach the room.
        if (systemMessage) io.to(convRoom(conversationId)).emit('support:message', systemMessage)
      } catch (err) {
        fail(socket, conversationId, err)
        return
      }

      // Past the commit, for the same reason as support:send: the escalation
      // has happened, and the contact fallback below reads cluster state over
      // Redis. A failure there must not report the escalation as failed.
      try {
        await broadcastQueue(conversationId)

        // Escalating into an empty room must hand over a phone number,
        // not silence.
        if (!(await anyAgentOnlineWithin(AGENT_PRESENCE_TIMEOUT_MS))) {
          const contact = await SupportContact.get()
          socket.emit('support:contact-fallback', { conversationId, ...contact })
        }
      } catch (err) {
        console.error('[support.gateway] post-commit', err)
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
          // markReadByAgent just zeroed this thread's unread count. Without
          // the broadcast the badge on every other clerk's queue keeps the
          // old number until some unrelated event happens to refresh it,
          // which is what made the read protocol look like it did nothing.
          await broadcastQueue(conversationId)
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
