// Service worker: performs the actual receipt fetch with the extension's
// host_permissions, which bypass the page's CORS restriction. A content-script
// or page fetch to telebirr is blocked/opaque; a background fetch is not.
const RECEIPT_PREFIX = 'https://transactioninfo.ethiotelecom.et/receipt/'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'FETCH_RECEIPT') return
  // Defence in depth: only ever fetch telebirr receipt URLs, never an arbitrary
  // URL a compromised page might ask for.
  if (typeof msg.url !== 'string' || !msg.url.startsWith(RECEIPT_PREFIX)) {
    sendResponse({ ok: false, error: 'BAD_URL' })
    return
  }
  fetch(msg.url, { credentials: 'omit', redirect: 'follow' })
    .then(async (r) => {
      const html = await r.text()
      sendResponse({ ok: r.ok, status: r.status, html })
    })
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
  return true // keep the message channel open for the async sendResponse
})
