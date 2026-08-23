import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/storage', () => ({
  uploadFile: vi.fn(),
}))

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { uploadFile } from '../lib/storage'
import supportRoutes from '../routes/support/index'

// Builds a raw multipart/form-data body by hand (no `form-data` package
// dependency available in this workspace) so we can drive real requests
// through app.inject() and exercise the actual busboy parsing in
// @fastify/multipart, rather than stubbing `req.file()` directly.
const BOUNDARY = 'supportAttachmentTestBoundary'

function buildMultipartBody(
  fields: Array<{ name: string; filename?: string; contentType?: string; value: Buffer | string }>,
): Buffer {
  const parts: Buffer[] = []
  for (const field of fields) {
    let head = `--${BOUNDARY}\r\n`
    if (field.filename) {
      head += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`
      head += `Content-Type: ${field.contentType ?? 'application/octet-stream'}\r\n\r\n`
    } else {
      head += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
    }
    parts.push(Buffer.from(head, 'utf8'))
    parts.push(typeof field.value === 'string' ? Buffer.from(field.value, 'utf8') : field.value)
    parts.push(Buffer.from('\r\n', 'utf8'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

// A pass-through authenticate mock — simulates a request that already
// carried a valid JWT, matching how support-contact.test.ts mocks
// requireAdmin for the settings route.
async function passAuthenticate() {}

// Mirrors what the real `authenticate` decorator does when
// `request.jwtVerify()` rejects: it hands the error to `reply.send`, which
// (via @fastify/jwt) responds 401 and short-circuits the request before the
// route handler — and therefore `uploadFile` — ever runs.
async function rejectAuthenticate(_req: any, reply: any) {
  return reply.status(401).send({ error: 'Unauthorized' })
}

async function buildApp(authenticate: (req: any, reply: any) => Promise<any>) {
  const app = Fastify({ logger: false })
  app.decorate('authenticate', authenticate)
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } })
  await app.register(supportRoutes, { prefix: '/support' })
  await app.ready()
  return app
}

describe('POST /support/attachments', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an unauthenticated request before any upload is attempted', async () => {
    const app = await buildApp(rejectAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: buildMultipartBody([
        {
          name: 'file',
          filename: 'receipt.png',
          contentType: 'image/png',
          value: Buffer.from('img'),
        },
      ]),
    })

    expect(res.statusCode).toBe(401)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('returns 400 with an error body when authenticated but no file part is sent', async () => {
    const app = await buildApp(passAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      // A well-formed multipart body with zero parts — no file field at all.
      payload: buildMultipartBody([]),
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body).toHaveProperty('error')
    expect(typeof body.error).toBe('string')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('returns the url and mimetype from uploadFile on a valid authenticated upload', async () => {
    ;(uploadFile as any).mockResolvedValue({
      url: '/uploads/1234-abcd.png',
      filename: '1234-abcd.png',
      size: 3,
      mimetype: 'image/png',
    })
    const app = await buildApp(passAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: buildMultipartBody([
        {
          name: 'file',
          filename: 'receipt.png',
          contentType: 'image/png',
          value: Buffer.from('img'),
        },
      ]),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ url: '/uploads/1234-abcd.png', mimetype: 'image/png' })
    expect(uploadFile).toHaveBeenCalledTimes(1)
    const [buffer, filename, mimetype] = (uploadFile as any).mock.calls[0]
    expect(Buffer.isBuffer(buffer)).toBe(true)
    // The route strips the client-supplied extension before calling
    // uploadFile (see the extension-spoofing fix below) — the on-disk
    // extension is derived from the mimetype instead, so the name handed to
    // uploadFile is the base name with no extension at all.
    expect(filename).toBe('receipt')
    expect(mimetype).toBe('image/png')
  })

  // Security fix: validateFile only string-matches the client-supplied
  // Content-Type — it never inspects bytes — and uploadToLocal derives the
  // on-disk extension as `path.extname(originalFilename) || mimeToExt(mimetype)`,
  // meaning the client's filename wins whenever it has an extension. Without
  // the fix, a part claiming `image/png` but named `evil.html` would be
  // written as `<ts>-<rand>.html` and served back from /uploads by
  // @fastify/static as text/html on the API's own origin. These tests assert
  // on the actual second argument passed to uploadFile — not merely that it
  // was called — so they fail against the vulnerable code.
  it('strips a spoofed .html extension from an image/png part before calling uploadFile', async () => {
    ;(uploadFile as any).mockResolvedValue({
      url: '/uploads/1234-abcd.png',
      filename: '1234-abcd.png',
      size: 3,
      mimetype: 'image/png',
    })
    const app = await buildApp(passAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: buildMultipartBody([
        {
          name: 'file',
          filename: 'evil.html',
          contentType: 'image/png',
          value: Buffer.from('img'),
        },
      ]),
    })

    expect(res.statusCode).toBe(200)
    expect(uploadFile).toHaveBeenCalledTimes(1)
    const [, filename] = (uploadFile as any).mock.calls[0]
    expect(filename).toBe('evil')
    expect(filename).not.toMatch(/\.html$/)
    expect(filename).not.toContain('.html')
  })

  it('falls back to a default base name when the part has no filename at all', async () => {
    ;(uploadFile as any).mockResolvedValue({
      url: '/uploads/1234-abcd.png',
      filename: '1234-abcd.png',
      size: 3,
      mimetype: 'image/png',
    })
    const app = await buildApp(passAuthenticate)

    // busboy (via @fastify/multipart) only treats a part as a *file* part
    // when the part's Content-Disposition carries a `filename` attribute
    // (even an empty one) OR its Content-Type is exactly
    // `application/octet-stream` (see @fastify/busboy's `isPartAFile`). To
    // get a part whose `filename` property is genuinely `undefined` — not
    // just an empty string — the Content-Disposition below omits the
    // `filename` attribute entirely and relies on the octet-stream
    // Content-Type to still be recognized as a file upload. This exercises
    // the route's `part.filename ?? 'attachment'` fallback rather than
    // throwing, without stubbing `req.file()` directly.
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n`, 'utf8'),
      Buffer.from('Content-Disposition: form-data; name="file"\r\n', 'utf8'),
      Buffer.from('Content-Type: application/octet-stream\r\n\r\n', 'utf8'),
      Buffer.from('img', 'utf8'),
      Buffer.from('\r\n', 'utf8'),
      Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'),
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(uploadFile).toHaveBeenCalledTimes(1)
    const [, filename] = (uploadFile as any).mock.calls[0]
    expect(filename).toBe('attachment')
  })

  // The important case: uploadFile (via lib/storage's validateFile) throws
  // for an oversized file or a disallowed MIME type. A player attaching a
  // 20MB photo or a PDF must get a 400 with that message back, not a 500 or
  // an unhandled rejection.
  it('returns 400 carrying the error message when uploadFile throws (oversized file)', async () => {
    ;(uploadFile as any).mockRejectedValue(new Error('File too large. Maximum size is 5MB.'))
    const app = await buildApp(passAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: buildMultipartBody([
        { name: 'file', filename: 'huge.png', contentType: 'image/png', value: Buffer.from('img') },
      ]),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'File too large. Maximum size is 5MB.' })
  })

  it('returns 400 carrying the error message when uploadFile throws (disallowed MIME type)', async () => {
    ;(uploadFile as any).mockRejectedValue(
      new Error('Invalid file type. Allowed: image/jpeg, image/jpg, image/png, image/webp'),
    )
    const app = await buildApp(passAuthenticate)

    const res = await app.inject({
      method: 'POST',
      url: '/support/attachments',
      headers: multipartHeaders,
      payload: buildMultipartBody([
        {
          name: 'file',
          filename: 'receipt.pdf',
          contentType: 'application/pdf',
          value: Buffer.from('%PDF'),
        },
      ]),
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid file type/)
  })
})
