import https from 'node:https'
import crypto from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const DEFAULT_BASE = 'https://transactioninfo.ethiotelecom.et/receipt/'

export type FetchReason = 'RATE_LIMITED' | 'NOT_FOUND' | 'UNREACHABLE' | 'PIN_MISMATCH'

/**
 * Build the outbound agent for receipt fetches. When DEPOSIT_VERIFY_PROXY is set,
 * route through it (http(s):// via CONNECT tunnel, or socks(4|5):// via SOCKS) so a
 * server that can't reach ethiotelecom's domestic network egresses elsewhere. TLS to
 * the receipt host stays relaxed (ethiotelecom cert-chain issues) — which is why an
 * UNTRUSTED proxy must only be used in shadow mode (cap 0): it could MITM/forge a
 * receipt. Scoped to receipt fetches only — other outbound traffic is unaffected.
 */
export function buildAgent(proxyUrl: string | undefined): https.Agent {
  if (!proxyUrl) return new https.Agent({ rejectUnauthorized: false })
  const scheme = proxyUrl.toLowerCase()
  if (scheme.startsWith('socks')) {
    // SOCKS: destination TLS is relaxed via the request-level rejectUnauthorized in https.get.
    return new SocksProxyAgent(proxyUrl) as unknown as https.Agent
  }
  // HTTPS proxy (CONNECT tunnel): the agent performs the destination TLS handshake itself.
  return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false }) as unknown as https.Agent
}

/**
 * Public-key pinning for the receipt host. TLS to ethiotelecom is CA-relaxed
 * (rejectUnauthorized:false) because of chain issues, which on its own lets an
 * untrusted proxy MITM/forge a receipt. Pinning the origin's SPKI restores
 * end-to-end authenticity: both proxy paths (CONNECT tunnel / SOCKS) do the
 * destination TLS handshake themselves, so a proxy that can't present the pinned
 * key can't tamper. With a pin set, a forged cert fails closed (no credit).
 */

/** sha256(base64) of a cert's DER SubjectPublicKeyInfo — the pin value. */
export function spkiPin(der: Buffer | Uint8Array): string {
  const cert = new crypto.X509Certificate(Buffer.from(der))
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(spkiDer).digest('base64')
}

/** Parse a comma-separated pin list; trims, drops empties. */
export function parsePins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Verify a peer cert against the allowed pin set.
 * Empty pin set = unpinned → accept (legacy/shadow-only behaviour).
 */
export function checkSpkiPin(
  der: Buffer | Uint8Array,
  pins: string[],
): { ok: true } | { ok: false; got: string } {
  if (pins.length === 0) return { ok: true }
  const got = spkiPin(der)
  return pins.includes(got) ? { ok: true } : { ok: false, got }
}

const PINNED_SPKI = parsePins(process.env.DEPOSIT_VERIFY_SPKI_PINS)
if (PINNED_SPKI.length) {
  console.log(`[deposit-verify] receipt host pinned to ${PINNED_SPKI.length} SPKI key(s)`)
}

function maskProxy(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(set)'
  }
}

const PROXY_URL = process.env.DEPOSIT_VERIFY_PROXY || ''
if (PROXY_URL) {
  console.log(`[deposit-verify] receipt fetches routed through proxy ${maskProxy(PROXY_URL)}`)
}

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

// Relaxed-TLS agent scoped to THIS module only (ethiotelecom presents cert-chain issues),
// optionally routed through DEPOSIT_VERIFY_PROXY.
const receiptAgent = buildAgent(PROXY_URL)

export async function fetchReceiptHtml(
  transactionId: string,
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<{ ok: true; html: string } | { ok: false; reason: FetchReason }> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const url = (opts.baseUrl ?? DEFAULT_BASE) + encodeURIComponent(transactionId)

  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: true; html: string } | { ok: false; reason: FetchReason }) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const req = https.get(
      url,
      {
        agent: receiptAgent,
        rejectUnauthorized: false,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json' },
      },
      (res) => {
        // Enforce the SPKI pin the moment the response arrives, before trusting any
        // bytes. FAIL CLOSED: when pins are configured we require a genuine TLS peer
        // cert that matches. A proxy that answers over plaintext (no getPeerCertificate)
        // or presents a forged cert is refused — it must never yield html.
        if (PINNED_SPKI.length) {
          const sock = res.socket as Partial<TLSSocket>
          const der =
            typeof sock.getPeerCertificate === 'function'
              ? sock.getPeerCertificate(true)?.raw
              : undefined
          const verdict = der ? checkSpkiPin(der, PINNED_SPKI) : { ok: false as const, got: 'no-tls-cert' }
          if (verdict.ok !== true) {
            req.destroy()
            console.error(
              `[deposit-verify] fetch ${transactionId}: SPKI PIN MISMATCH got=${verdict.got} — refusing receipt (possible MITM, plaintext proxy, or cert rotation)`,
            )
            done({ ok: false, reason: 'PIN_MISMATCH' })
            return
          }
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 2_000_000) {
            req.destroy()
            console.warn(`[deposit-verify] fetch ${transactionId}: response too large (>2MB)`)
            done({ ok: false, reason: 'UNREACHABLE' })
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
          if (c.kind === 'html') {
            done({ ok: true, html: c.html })
          } else {
            console.warn(
              `[deposit-verify] fetch ${transactionId}: status=${res.statusCode} type=${res.headers['content-type']} -> ${c.reason} body="${body.slice(0, 160).replace(/\s+/g, ' ')}"`,
            )
            done({ ok: false, reason: c.reason })
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      console.warn(`[deposit-verify] fetch ${transactionId}: TIMEOUT after ${timeoutMs}ms (${url})`)
      done({ ok: false, reason: 'UNREACHABLE' })
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      console.warn(
        `[deposit-verify] fetch ${transactionId}: ERROR code=${err.code ?? '?'} msg="${err.message}" (${url})`,
      )
      done({ ok: false, reason: 'UNREACHABLE' })
    })
  })
}
