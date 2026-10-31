import { FastifyPluginAsync } from 'fastify'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { NotificationController } from '../../controllers/notification.controller'
import { TelegramNotifyPatchSchema, TelegramNotifyPatchDto } from '@world-bingo/shared-types'
import { setNotifyEnabled, unlinkChat } from '../../services/telegram/link.service.js'
import { AccountStatusService } from '../../services/account-status.service.js'

const userRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    // GET /notifications — get unread notifications
    fastify.get('/notifications', NotificationController.getUnread)

    // POST /notifications/:id/read — mark single as read
    fastify.post('/notifications/:id/read', NotificationController.markAsRead)

    // POST /notifications/read-all — mark all as read
    fastify.post('/notifications/read-all', NotificationController.markAllRead)

    // ── Telegram support bot link ───────────────────────────────────────
    // Minting the link token itself is POST /support/telegram/link — see
    // routes/support/index.ts. These two only touch an EXISTING link.

    // PATCH /user/telegram — toggle notification pushes for a linked chat.
    fastify.patch<{ Body: TelegramNotifyPatchDto }>('/telegram', {
        schema: { body: zodToJsonSchema(TelegramNotifyPatchSchema) },
        handler: async (req) => {
            // @ts-ignore
            await setNotifyEnabled(req.user.id, req.body.notifyEnabled)
            return { ok: true }
        },
    })

    // DELETE /user/telegram — unlink. Idempotent: unlinking an account with
    // no link just clears columns that were already null.
    fastify.delete('/telegram', async (req) => {
        // @ts-ignore
        await unlinkChat(req.user.id)
        return { ok: true }
    })

    // GET /user/account-status — the plain-language version of
    // "contact support": category + auto-restore date, never the
    // staff-internal free-text reason. See AccountStatusService.playerView.
    fastify.get('/account-status', async (req) => {
        // @ts-ignore
        return AccountStatusService.playerView(req.user.id)
    })
}

export default userRoutes
