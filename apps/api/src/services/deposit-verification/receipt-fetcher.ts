import https from 'node:https'

const DEFAULT_BASE = 'https://transactioninfo.ethiotelecom.et/receipt/'

export type FetchReason = 'RATE_LIMITED' | 'NOT_FOUND' | 'UNREACHABLE'

export function classifyReceiptResponse(
  status: number,
  contentType: string,
  body: string,
): { kind: 'html'; html: string } | { kind: 'unavailable'; reason: FetchReason } {
  const isJson = contentType.includes('application/json')
  const looksRateLimited = /rate limit/i.test(body)

  if (status === 429 || (isJson && looksRateLimited)) {
    return { kind: 'unavailable', reason: 'RATE_LIMITED' }
  }
  if (status >= 500) return { kind: 'unavailable', reason: 'UNREACHABLE' }
  if (status === 404) return { kind: 'unavailable', reason: 'NOT_FOUND' }
  if (status !== 200) return { kind: 'unavailable', reason: 'UNREACHABLE' }
  return { kind: 'html', html: body }
}

// Relaxed-TLS agent scoped to THIS module only (ethiotelecom presents cert-chain issues).
const insecureAgent = new https.Agent({ rejectUnauthorized: false })

export async function fetchReceiptHtml(
  transactionId: string,
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<{ ok: true; html: string } | { ok: false; reason: FetchReason }> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = (opts.baseUrl ?? DEFAULT_BASE) + encodeURIComponent(transactionId)

  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        agent: insecureAgent,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 2_000_000) {
            req.destroy()
            resolve({ ok: false, reason: 'UNREACHABLE' })
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const c = classifyReceiptResponse(
            res.statusCode ?? 0,
            String(res.headers['content-type'] ?? ''),
            body,
          )
          if (c.kind === 'html') resolve({ ok: true, html: c.html })
          else resolve({ ok: false, reason: c.reason })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ ok: false, reason: 'UNREACHABLE' })
    })
    req.on('error', () => resolve({ ok: false, reason: 'UNREACHABLE' }))
  })
}
