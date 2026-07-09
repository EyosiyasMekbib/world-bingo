#!/usr/bin/env node
// Diagnose why telebirr receipt fetching fails — run FROM the box that's failing
// (e.g. inside the prod api container) so it exercises the real egress:
//
//   docker exec <api-container> node scripts/diagnose-receipt-fetch.mjs [txId]
//
// It classifies the failure into one actionable bucket and prints a verdict:
//   DNS         -> resolver broken in the container (not a proxy problem)
//   UNREACHABLE -> box can't reach the host -> set DEPOSIT_VERIFY_PROXY
//   PIN_MISMATCH-> proxy/path is tampering (or cert rotated) -> recapture pin
//   RATE_LIMITED-> host is throttling -> back off concurrency / cooldown
//   REACHABLE   -> egress is fine; failure is downstream (parser on real HTML)
//
// Honours the same env the app uses: DEPOSIT_VERIFY_PROXY, DEPOSIT_VERIFY_SPKI_PINS.
import https from 'node:https'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const HOST = 'transactioninfo.ethiotelecom.et'
const txId = process.argv[2] || 'TEST123'
const PROXY = process.env.DEPOSIT_VERIFY_PROXY || ''
const PINS = (process.env.DEPOSIT_VERIFY_SPKI_PINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const spkiPin = (der) =>
  crypto
    .createHash('sha256')
    .update(new crypto.X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')

function agentFor(proxyUrl) {
  if (!proxyUrl) return new https.Agent({ rejectUnauthorized: false })
  if (proxyUrl.toLowerCase().startsWith('socks')) return new SocksProxyAgent(proxyUrl)
  return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false })
}

function attempt(label, proxyUrl) {
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      resolve({ label, ...v })
    }
    let req
    try {
      req = https.get(
        {
          host: HOST,
          path: '/receipt/' + encodeURIComponent(txId),
          agent: agentFor(proxyUrl),
          rejectUnauthorized: false,
          servername: HOST,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json' },
        },
        (res) => {
          let pin = 'no-tls'
          try {
            const s = res.socket
            if (typeof s.getPeerCertificate === 'function') {
              const der = s.getPeerCertificate(true)?.raw
              pin = der ? spkiPin(der) : 'none'
            }
          } catch {
            pin = 'err'
          }
          const chunks = []
          res.on('data', (c) => chunks.length < 50 && chunks.push(c))
          res.on('end', () =>
            fin({
              status: res.statusCode,
              type: String(res.headers['content-type'] || ''),
              pin,
              body: Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' '),
            }),
          )
        },
      )
    } catch (e) {
      return fin({ error: e.code || e.message })
    }
    req.setTimeout(15000, () => {
      req.destroy()
      fin({ error: 'TIMEOUT' })
    })
    req.on('error', (e) => fin({ error: e.code || e.message }))
  })
}

function verdict(direct, proxied) {
  const r = proxied ?? direct
  if (r.error === 'ENOTFOUND' || r.error === 'EAI_AGAIN') return ['DNS', 'Resolver broken in container — fix DNS, not a proxy issue.']
  if (r.error) return ['UNREACHABLE', `Box can't reach ${HOST} (${r.error}). Set DEPOSIT_VERIFY_PROXY to a live egress.`]
  if (PINS.length && r.pin !== 'no-tls' && !PINS.includes(r.pin))
    return ['PIN_MISMATCH', `Peer key ${r.pin} not in DEPOSIT_VERIFY_SPKI_PINS — tampering or cert rotation. Recapture from a trusted vantage.`]
  if (r.status === 429 || /rate limit/i.test(r.body)) return ['RATE_LIMITED', 'Host is throttling — lower concurrency / raise cooldown.']
  if (r.status === 200) return ['REACHABLE', 'Egress is FINE. Failure is downstream: reconcile the parser against a real receipt (labels), or check the tx id.']
  return ['UNREACHABLE', `Unexpected status ${r.status}.`]
}

const main = async () => {
  console.log(`# receipt-fetch diagnosis  host=${HOST}  txId=${txId}`)
  console.log(`# proxy=${PROXY || '(none)'}  pins=${PINS.length}`)
  try {
    const ips = await dns.lookup(HOST, { all: true })
    console.log('DNS      ->', ips.map((i) => i.address).join(', '))
  } catch (e) {
    console.log('DNS      -> FAILED', e.code || e.message)
  }
  const direct = await attempt('DIRECT', '')
  console.log('DIRECT   ->', JSON.stringify(direct))
  let proxied = null
  if (PROXY) {
    proxied = await attempt('PROXY', PROXY)
    console.log('PROXY    ->', JSON.stringify(proxied))
  }
  const [code, action] = verdict(direct, proxied)
  console.log('')
  console.log(`VERDICT: ${code}`)
  console.log(`ACTION:  ${action}`)
}
main()
