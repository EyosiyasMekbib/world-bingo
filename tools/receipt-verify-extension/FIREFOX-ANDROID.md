# Installing on Firefox for Android (mobile clerks)

Chrome/Safari on mobile have **no extension support** — Firefox for Android is the
only mobile browser that runs extensions. This is the mobile-clerk path.

There's no "load unpacked" on a phone. Firefox Android only installs a **signed**
extension. Two routes: **A** for real clerks (signed, install from a link),
**B** for quick testing (no signing, Nightly only).

---

## Route A — Sign once, clerks install from a link (recommended)

Mozilla signs the extension for free; "unlisted" means no public listing and no
review wait. You do this **once**; every clerk just opens a URL.

### 1. Get AMO API credentials (one time)
- Sign in at <https://addons.mozilla.org> → **Developer Hub** → **Manage API Keys**.
- Copy the **JWT issuer** and **JWT secret**.

### 2. Sign the extension
From `tools/receipt-verify-extension/`:

```bash
npx web-ext sign --channel=unlisted \
  --api-key="<JWT issuer>" \
  --api-secret="<JWT secret>"
```

This produces a Mozilla-signed **`.xpi`** in `web-ext-artifacts/`
(e.g. `receipt_helper-1.0.0.xpi`). `web-ext lint` may warn that `background`
has both `service_worker` and `scripts` — that's expected and fine (Chrome uses
one, Firefox the other).

### 3. Host the `.xpi` at a URL clerks can open
Put it anywhere Firefox Android can reach — simplest is next to the admin app,
e.g. `https://admin.aradabingo.bet/receipt-helper.xpi`. Must be served with
`Content-Type: application/x-xpinstall` (most static hosts do this for `.xpi`;
if not, set it).

### 4. Each clerk (once, on their phone)
1. Open **Firefox for Android** (regular/stable, v121+).
2. Go to the `.xpi` URL → Firefox shows an **Add to Firefox** / install prompt → **Add**.
3. Open `https://admin.aradabingo.bet`, go to **Deposits**, tap **Check**.

To update later: bump `version` in `manifest.json`, re-sign, replace the hosted
`.xpi`. Clerks re-open the URL to update (or Firefox auto-updates from `update_url`
if you add one).

---

## Route B — Quick test on Firefox **Nightly** for Android (no signing)

Good for confirming it works before you sign. Requires **Firefox Nightly** (not
stable) and a one-time AMO **collection**.

1. Upload the extension to an AMO **collection** (addons.mozilla.org → your
   profile → Collections → create one → add this add-on). Note your **AMO user
   ID** (numeric, in your profile URL) and the **collection name**.
2. On Firefox Nightly Android: **Settings → About Firefox Nightly** → tap the
   logo **5×** to unlock the debug menu.
3. **Settings → Advanced → Custom Add-on collection** → enter your user ID +
   collection name → Firefox restarts.
4. **Settings → Add-ons** → your extension is now installable.

---

## Reality check — it fixes CORS, not geography

The extension bypasses the browser CORS block. The phone must still be **on an
Ethiopian network** (Ethio Telecom mobile data / ET Wi-Fi) to actually reach
`transactioninfo.ethiotelecom.et`. A clerk physically in Ethiopia is fine; the
same extension on a phone outside Ethiopia will still fail to fetch (same as the
server). Test on a real ET device.

---

## If Firefox Android is too much friction

The alternative that needs **zero** on-device setup is server-side fetch through
an Ethiopian egress (an ET VPS / proxy → `DEPOSIT_VERIFY_PROXY`). Then the API
verifies receipts itself and any device — including Chrome/Safari mobile — just
sees the result. See the deposit-verification env in the API `.env.example`.
