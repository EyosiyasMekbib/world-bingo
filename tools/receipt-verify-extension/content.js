// Bridge between the admin page (deposits.vue) and the extension background.
//
// Protocol (must match fetchViaExtension() in apps/admin/pages/deposits.vue):
//   page  -> window.postMessage({ type: 'WB_FETCH_RECEIPT', id, url })
//   page  <- window.postMessage({ type: 'WB_RECEIPT_RESULT', id, html })
//
// The page can't fetch telebirr itself (CORS); we relay the request to the
// background service worker, which fetches with host_permissions, then post the
// HTML back to the page. The page POSTs it to /admin/transactions/:id/verify-receipt.
const RECEIPT_PREFIX = 'https://transactioninfo.ethiotelecom.et/receipt/'

window.addEventListener('message', (event) => {
  // Only accept messages from this same page (not iframes or other windows).
  if (event.source !== window) return
  const msg = event.data
  if (!msg || msg.type !== 'WB_FETCH_RECEIPT' || typeof msg.url !== 'string') return

  const reply = (html, error) =>
    window.postMessage({ type: 'WB_RECEIPT_RESULT', id: msg.id, html: html ?? null, error: error ?? null }, '*')

  if (!msg.url.startsWith(RECEIPT_PREFIX)) {
    reply(null, 'BAD_URL')
    return
  }

  chrome.runtime.sendMessage({ type: 'FETCH_RECEIPT', url: msg.url }, (res) => {
    if (chrome.runtime.lastError) {
      reply(null, chrome.runtime.lastError.message)
      return
    }
    reply(res && res.ok ? res.html : null, res && res.ok ? null : (res && res.error) || 'FETCH_FAILED')
  })
})

// Announce presence so the page could optionally show a "helper installed" hint.
window.postMessage({ type: 'WB_RECEIPT_HELPER_READY' }, '*')
