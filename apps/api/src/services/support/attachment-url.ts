/**
 * Whether `url` is safe to persist and render as a support message
 * attachment.
 *
 * `attachmentUrl` arrives on the raw `support:send` socket payload —
 * nothing forces a client to have actually gone through the upload route
 * (`POST /support/attachments`, see `apps/api/src/lib/storage.ts`), so this
 * has to treat the value as attacker-controlled and validate its *shape*,
 * not merely trust it. The admin inbox renders it into an `<a href>`; a
 * `javascript:` value there executes in a CLERK's authenticated session on
 * click.
 *
 * `uploadFile()` in `lib/storage.ts` only ever produces two shapes:
 *   - local storage: a relative path `/uploads/<name>`
 *   - GCS / MinIO:    an absolute `http(s)://` URL
 * so those are exactly what's accepted here. Everything else — `javascript:`,
 * `data:`, `vbscript:`, protocol-relative `//host/...`, and unparseable
 * garbage — is rejected.
 *
 * Deliberately uses `new URL()` and checks `.protocol` rather than a
 * string-prefix / substring check: a naive `url.includes('/uploads/')` or
 * `url.startsWith('http')` is defeated by `javascript:/uploads/x.png` or
 * `javascriptx://...`. Parsing normalizes case and structure, so
 * `JaVaScRiPt:alert(1)` and friends are caught the same way.
 */
export function isSafeAttachmentUrl(url: string): boolean {
  if (!url) return false

  // Local-storage shape: a same-origin relative path. Never scheme-parsed,
  // so it can't be a `javascript:`/`data:` URL no matter what follows —
  // but it must be genuinely relative (start with a single `/`, not `//`,
  // which a browser resolves as protocol-relative to an attacker host).
  if (url.startsWith('/uploads/')) return true

  // GCS / MinIO shape: an absolute URL. Parse it — never string-match —
  // and require exactly http/https. `new URL()` is called with no base
  // argument, so a protocol-relative `//evil.com/x` (which has no scheme
  // of its own) fails to parse as absolute and is rejected below, rather
  // than silently inheriting whatever scheme a base would supply.
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
