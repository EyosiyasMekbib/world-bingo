#!/usr/bin/env node
// Capture the SPKI pin for the telebirr receipt host.
//
// SECURITY: run this from a TRUSTED vantage that reaches ethiotelecom directly
// (an ET box / VPS you control) — NEVER through the free/untrusted proxy you are
// trying to pin against, or you'll pin the attacker's key. Paste the printed
// value(s) into DEPOSIT_VERIFY_SPKI_PINS (comma-separated to allow rotation).
//
// Usage:
//   node scripts/capture-receipt-spki.mjs [host] [port]
//   node scripts/capture-receipt-spki.mjs transactioninfo.ethiotelecom.et 443
import tls from 'node:tls'
import crypto from 'node:crypto'

const host = process.argv[2] || 'transactioninfo.ethiotelecom.et'
const port = Number(process.argv[3] || 443)

const socket = tls.connect(
  // rejectUnauthorized:false only so a broken CA chain doesn't abort the capture;
  // we read the leaf key regardless and you verify it out-of-band.
  { host, port, servername: host, rejectUnauthorized: false, timeout: 15000 },
  () => {
    const cert = socket.getPeerCertificate(true)
    if (!cert || !cert.raw) {
      console.error('No peer certificate returned.')
      process.exit(1)
    }
    const x509 = new crypto.X509Certificate(cert.raw)
    const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
    const pin = crypto.createHash('sha256').update(spkiDer).digest('base64')
    console.log(`host:    ${host}:${port}`)
    console.log(`subject: ${cert.subject && cert.subject.CN}`)
    console.log(`issuer:  ${cert.issuer && cert.issuer.CN}`)
    console.log(`valid:   ${cert.valid_from} -> ${cert.valid_to}`)
    console.log('')
    console.log(`DEPOSIT_VERIFY_SPKI_PINS=${pin}`)
    socket.end()
  },
)
socket.on('timeout', () => {
  console.error(`Timed out connecting to ${host}:${port} — is this host reachable from here?`)
  socket.destroy()
  process.exit(1)
})
socket.on('error', (err) => {
  console.error(`Connect error: ${err.message}`)
  process.exit(1)
})
