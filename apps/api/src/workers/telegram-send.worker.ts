/**
 * Sends queued Telegram pushes (services/telegram/notify.ts).
 *
 * Deliberately re-reads the user's link state here rather than trusting
 * what was true at enqueue time: a player can unlink, block the bot, or
 * flip the notify toggle in the seconds a job sits in the queue, and this
 * is the last point before a message actually goes out.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { reportError } from '../lib/sentry.js'
import prisma from '../lib/prisma.js'
import { telegramClient, TelegramApiError } from '../gateways/telegram/client.js'
import { isEnabled } from '../gateways/telegram/config.js'
import type { TelegramSendJobData } from '../services/telegram/notify.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Named `processJob`, not `process` — a module-scope function named
// `process` shadows Node's global `process` for the WHOLE module, including
// `process.env.REDIS_URL` above, because function declarations hoist.
async function processJob(job: Job<TelegramSendJobData>): Promise<{ sent: boolean; reason?: string }> {
  // Env-gated like everything else here: a job already sitting in the
  // queue from before the bot was disabled must not send once it is.
  if (!isEnabled()) return { sent: false, reason: 'disabled' }

  const user = await prisma.user.findUnique({
    where: { id: job.data.userId },
    select: { telegramChatId: true, telegramNotifyEnabled: true, telegramBlockedAt: true },
  })
  if (!user?.telegramChatId) return { sent: false, reason: 'not_linked' }
  // Support replies are never opted out of — see notify.ts's TelegramSendJobData.
  if (job.data.kind === 'notification' && !user.telegramNotifyEnabled) {
    return { sent: false, reason: 'opted_out' }
  }
  if (user.telegramBlockedAt) return { sent: false, reason: 'blocked' }

  try {
    await telegramClient().sendMessage({
      chatId: user.telegramChatId,
      text: job.data.text,
      buttons:
        job.data.buttonUrl && job.data.buttonLabel
          ? [{ text: job.data.buttonLabel, url: job.data.buttonUrl }]
          : undefined,
    })
    return { sent: true }
  } catch (err) {
    if (err instanceof TelegramApiError) {
      if (err.blocked) {
        // Terminal and handled, not a failure: stamp it so notify.ts's next
        // enqueue never bothers, and the /start handler clears it the
        // moment the player comes back.
        await prisma.user
          .update({ where: { id: job.data.userId }, data: { telegramBlockedAt: new Date() } })
          .catch(() => {})
        return { sent: false, reason: 'blocked' }
      }
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        // A permanently bad request (chat not found, malformed text) —
        // retrying it would only burn the attempt budget on something that
        // can never succeed. Logged, not thrown.
        console.error('[TelegramSend] permanent failure', err.code, err.message)
        return { sent: false, reason: err.code }
      }
      // 429 or a 5xx: worth retrying. BullMQ's default backoff (see
      // lib/queue.ts) is exponential starting at 1s over 3 attempts — close
      // enough to a typical short rate-limit window without the extra
      // complexity of scheduling against Telegram's exact retry_after.
      throw err
    }
    throw err
  }
}

const worker = new Worker<TelegramSendJobData>(
  QUEUE_NAMES.TELEGRAM_SEND,
  processJob,
  {
    connection: {
      url: REDIS_URL,
      maxRetriesPerRequest: null as any,
      enableReadyCheck: false,
    } as any,
    concurrency: 10,
  },
)

worker.on('failed', (job, err) => {
  console.error(`[TelegramSend] job ${job?.id} failed:`, err.message)
  reportError(err, { worker: 'telegram-send' })
})

export default worker
