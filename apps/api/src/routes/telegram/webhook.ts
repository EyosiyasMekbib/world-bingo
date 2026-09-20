/**
 * POST /v1/telegram/webhook — Telegram's inbound delivery point. Registered
 * once at boot by gateways/telegram/bot.ts's setWebhook call, alongside the
 * secret token Telegram echoes back on every request (never in the URL —
 * see gateways/telegram/config.ts's WEBHOOK_PATH comment).
 */

import { FastifyPluginAsync } from 'fastify'
import redis from '../../lib/redis.js'
import { webhookSecret } from '../../gateways/telegram/config.js'
import { supportGroupId } from '../../gateways/telegram/config.js'
import type { TelegramUpdate } from '../../gateways/telegram/client.js'
import { handlePlayerMessage } from '../../services/telegram/player-handlers.js'
import { handleStaffGroupMessage } from '../../services/telegram/staff-handlers.js'

/** How long an update_id is remembered for dedupe. Generous — Telegram's
 *  own redelivery window is much shorter than this, but the cost of keeping
 *  a few thousand small keys a day longer than strictly necessary is
 *  nothing next to the cost of processing one twice. */
const UPDATE_DEDUPE_TTL_SECS = 86_400

/** Exported for a focused dispatch-logic test — see
 *  test/telegram-webhook-route.test.ts. The route handler below never
 *  awaits this; tests call it directly instead of going through Fastify. */
export async function processUpdate(update: TelegramUpdate): Promise<void> {
  const dedupeKey = `tg:update:${update.update_id}`
  // NX: the FIRST caller to write this key is the one that processes the
  // update. A redelivery (Telegram retries on anything slow or non-2xx,
  // which this route deliberately avoids by acking before this function
  // even runs — see the route handler) finds the key already there and
  // does nothing.
  const claimed = await redis.set(dedupeKey, '1', 'EX', UPDATE_DEDUPE_TTL_SECS, 'NX')
  if (claimed !== 'OK') return

  const message = update.message
  if (!message) return // unhandled update type (edited_message, etc.) — nothing to do

  if (message.chat.type === 'private') {
    await handlePlayerMessage(message)
    return
  }

  const groupId = supportGroupId()
  if (groupId && String(message.chat.id) === groupId) {
    await handleStaffGroupMessage(message)
  }
  // Any other chat type/id: the bot was added somewhere it has no business
  // being. Silently ignored — see handleStaffGroupMessage's own group-id
  // check too, which is the belt to this suspenders.
}

const telegramWebhookRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (req, reply) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) {
      return reply.status(401).send()
    }

    const update = req.body as TelegramUpdate | undefined
    if (!update || typeof update.update_id !== 'number') {
      return reply.status(200).send({ ok: true }) // malformed — ack anyway, never retry-worthy
    }

    // Ack immediately: Telegram's own timeout is short and it retries hard
    // on anything slow, which would otherwise double up with the dedupe
    // key's own NX race. Everything after this line runs in the
    // background, NOT awaited by the handler — see processUpdate's own
    // try/catch boundary at the call site below.
    reply.status(200).send({ ok: true })

    processUpdate(update).catch((err) => {
      console.error('[TelegramWebhook] update handling failed:', (err as Error)?.message, {
        update_id: update.update_id,
      })
    })
  })
}

export default telegramWebhookRoute
