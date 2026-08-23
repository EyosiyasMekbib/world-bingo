import { FastifyPluginAsync } from 'fastify'
import { uploadFile } from '../../lib/storage'

const supportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preValidation', fastify.authenticate)

  // ── POST /support/attachments ───────────────────────────────────────────
  // Deposit receipt screenshots are the highest-value attachment on this
  // platform. Validation, the 5MB cap and the local/GCS/MinIO switch all come
  // from lib/storage — this route adds no second upload path.
  fastify.post('/attachments', async (req, reply) => {
    const part = await (req as any).file()
    if (!part) return reply.status(400).send({ error: 'No file uploaded' })
    try {
      const buffer = await part.toBuffer()
      const result = await uploadFile(buffer, part.filename, part.mimetype)
      return { url: result.url, mimetype: result.mimetype }
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? 'Upload failed' })
    }
  })
}

export default supportRoutes
