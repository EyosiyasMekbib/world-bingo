import { FastifyPluginAsync } from 'fastify'
import { basename, extname } from 'path'
import { uploadFile } from '../../lib/storage'
import { mintPlayerLinkToken } from '../../services/telegram/link.service.js'
import { openAppeal, AlreadyActiveError } from '../../services/support/appeal.js'
import { SupportMessageSource } from '@world-bingo/shared-types'

const supportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preValidation', fastify.authenticate)

  // ── POST /support/telegram/link ─────────────────────────────────────────
  // Mints a one-time deep link into the bot for the SIGNED-IN player. Never
  // an error when the bot is disabled or the mint budget is spent — the
  // response just carries a null deepLink and the caller hides the button,
  // same as an unconfigured SupportContactInfo channel.
  fastify.post<{ Body: { conversationId?: string } }>('/telegram/link', async (req) => {
    // @ts-ignore
    const deepLink = await mintPlayerLinkToken(req.user.id, req.body?.conversationId)
    return { deepLink }
  })

  // ── POST /support/appeal ────────────────────────────────────────────────
  // The one-tap alternative to "contact support" on a restricted/suspended
  // account. See services/support/appeal.ts.
  fastify.post('/appeal', async (req, reply) => {
    try {
      // @ts-ignore
      await openAppeal(req.user.id, SupportMessageSource.WEB)
      return { ok: true }
    } catch (err) {
      if (err instanceof AlreadyActiveError) {
        return reply.status(409).send({ error: err.message, code: 'account_active' })
      }
      throw err
    }
  })

  // ── POST /support/attachments ───────────────────────────────────────────
  // Deposit receipt screenshots are the highest-value attachment on this
  // platform. Validation, the 5MB cap and the local/GCS/MinIO switch all come
  // from lib/storage — this route adds no second upload path.
  fastify.post('/attachments', async (req, reply) => {
    const part = await (req as any).file()
    if (!part) return reply.status(400).send({ error: 'No file uploaded' })
    try {
      const buffer = await part.toBuffer()
      // Strip the client's extension before handing the name to uploadFile.
      // uploadToLocal derives the on-disk extension from the filename first
      // (`path.extname(originalFilename) || mimeToExt(mimetype)`), and
      // validateFile only string-matches the client's Content-Type — it never
      // inspects bytes. A part claiming `image/png` but named `evil.html`
      // would otherwise be written as .html and served back from /uploads by
      // @fastify/static as text/html, on the API's own origin. Passing an
      // extensionless name forces the fallback, so the extension is derived
      // from the mimetype that actually passed the allowlist.
      const safeName = basename(part.filename ?? 'attachment', extname(part.filename ?? ''))
      const result = await uploadFile(buffer, safeName, part.mimetype)
      return { url: result.url, mimetype: result.mimetype }
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? 'Upload failed' })
    }
  })
}

export default supportRoutes
