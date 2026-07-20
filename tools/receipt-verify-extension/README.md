# Deposit Receipt Helper (browser extension)

Lets the admin **Deposits** page fetch telebirr receipts for verification.

## Why it exists

The API server is hosted outside Ethiopia and **cannot reach**
`transactioninfo.ethiotelecom.et` (you'll see `UNAVAILABLE / UNREACHABLE`
verifications). A clerk's browser, on an Ethiopian network, *can* reach it — but
a normal page `fetch()` to telebirr is blocked by CORS (telebirr doesn't send
cross-origin headers for our domain).

This extension does the fetch in its **background service worker**, whose
`host_permissions` bypass CORS. The admin page asks the extension via
`postMessage`, gets the receipt HTML back, and POSTs it to the API's
`/admin/transactions/:id/verify-receipt`, which runs the normal
parse → match → credit pipeline.

```
deposits.vue ──postMessage──▶ content.js ──▶ background.js ──fetch──▶ telebirr
     ▲                                                                    │
     └──────────── receipt HTML (postMessage) ◀───────────────────────────┘
```

## Requirements

- The browser must be **on an Ethiopian network** (Ethio Telecom, or an ET
  VPN). The extension solves CORS, **not** geography — if the machine can't
  reach telebirr at all, the fetch still fails. Real clerks in Ethiopia are the
  intended users.
- **Desktop:** Chrome / Edge / any Chromium browser (Manifest V3). Firefox works too.
- **Mobile:** **Firefox for Android only** — Chrome/Safari on mobile have no
  extension support. See **[FIREFOX-ANDROID.md](./FIREFOX-ANDROID.md)** for the
  signing + install steps (there's no "load unpacked" on a phone).

The manifest ships both a `service_worker` (Chrome) and `scripts` (Firefox/Android)
background so one folder works in both engines.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this folder
   (`tools/receipt-verify-extension`).
4. Open `https://admin.aradabingo.bet`, go to **Deposits**, click **Check** (or
   **Check All**). Receipts now resolve instead of showing
   "Receipt unreachable from this browser".

No sign-in, no configuration. Nothing is sent anywhere except: the receipt fetch
to telebirr, and the receipt HTML back to your own admin page.

## Security

- The background worker only ever fetches URLs starting with
  `https://transactioninfo.ethiotelecom.et/receipt/` — it will refuse any other
  URL the page names.
- The content script only runs on `admin.aradabingo.bet` and `localhost:3001`
  (see `manifest.json` → `content_scripts.matches`). Add other admin domains
  there if needed (e.g. a betbawa admin host).
- `host_permissions` is scoped to the telebirr receipt host only.

## Distributing to clerks

- **Mobile clerks (the common case here):** Firefox for Android — see
  **[FIREFOX-ANDROID.md](./FIREFOX-ANDROID.md)**. Sign once (free, unlisted),
  host the `.xpi`, clerks install from a link.
- **Desktop clerks:** "Load unpacked" per machine, or `chrome://extensions` →
  **Pack extension** → `.crx`, or an unlisted Chrome Web Store item / enterprise
  force-install policy.

## Alternative: no extension at all

If Firefox-on-Android is too much friction across a mobile fleet, the other
solution is **server-side fetch through an Ethiopian egress** (an ET VPS / proxy
wired to `DEPOSIT_VERIFY_PROXY`). The API then verifies receipts itself and
**any** device — including Chrome/Safari mobile — just sees the verdict, with no
on-device install. The two approaches are interchangeable; pick per how your
clerks actually work.
