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
 * `uploadFile()` in `lib/storage.ts` only ever produces:
 *   - local storage: a relative path `/uploads/<name>`
 *   - MinIO:          an absolute `http(s)://` URL on `MINIO_ENDPOINT`'s host
 *   - GCS:            a signed URL on `storage.googleapis.com`
 * so an absolute URL is only ever legitimate on one of those exact hosts —
 * accepting "any http(s) URL" is a much bigger surface than the real output
 * shape, and is exactly what lets a PLAYER (staffActor is NOT required to
 * set attachmentUrl) plant a credential-phishing link — dressed as a
 * payment receipt, with no visible URL text in the admin inbox thumbnail —
 * in front of a CLERK who handles player money. So beyond scheme, the HOST
 * must also match an exact allowlist built from configuration.
 *
 * Deliberately uses `new URL()` and checks `.protocol` rather than a
 * string-prefix / substring check: a naive `url.includes('/uploads/')` or
 * `url.startsWith('http')` is defeated by `javascript:/uploads/x.png` or
 * `javascriptx://...`. Parsing normalizes case and structure, so
 * `JaVaScRiPt:alert(1)` and friends are caught the same way.
 */

/**
 * Builds the set of hosts an absolute attachment URL is allowed to point
 * at, read from configuration on every call (not cached at module load) so
 * tests can set `process.env` per case and so a runtime config change takes
 * effect without a restart-order dependency.
 *
 * When nothing below is configured — the default local-dev case — this
 * returns an EMPTY set, so no absolute URL is accepted at all and only the
 * relative `/uploads/` shape passes. That is the correct, safe default:
 * an empty allowlist can never be accidentally bypassed by a permissive
 * fallback.
 */
function buildAllowedHosts(): Set<string> {
  const hosts = new Set<string>()

  // MinIO: parse the endpoint with `new URL()` and take its `.host` — never
  // string-slice the env var, which would be one typo away from producing
  // a host check that doesn't match what MinIO's client actually connects to.
  const minioEndpoint = process.env.MINIO_ENDPOINT
  if (minioEndpoint) {
    try {
      hosts.add(new URL(minioEndpoint).host.toLowerCase())
    } catch {
      // Malformed MINIO_ENDPOINT contributes nothing — never let a bad env
      // value crash validation or silently widen the allowlist.
    }
  }

  // GCS: uploadToGcs() only ever signs URLs on this fixed host.
  if (process.env.GCS_BUCKET) {
    hosts.add('storage.googleapis.com')
  }

  // Escape hatch for any other configured storage host.
  const extra = process.env.SUPPORT_ATTACHMENT_HOSTS
  if (extra) {
    for (const raw of extra.split(',')) {
      const trimmed = raw.trim().toLowerCase()
      if (trimmed) hosts.add(trimmed)
    }
  }

  return hosts
}

export function isSafeAttachmentUrl(url: string): boolean {
  if (!url) return false

  // Local-storage shape: a same-origin relative path. Never scheme-parsed,
  // so it can't be a `javascript:`/`data:` URL no matter what follows —
  // but it must be genuinely relative (start with a single `/`, not `//`,
  // which a browser resolves as protocol-relative to an attacker host).
  if (url.startsWith('/uploads/')) return true

  // MinIO / GCS shape: an absolute URL. Parse it — never string-match —
  // and require exactly http/https. `new URL()` is called with no base
  // argument, so a protocol-relative `//evil.com/x` (which has no scheme
  // of its own) fails to parse as absolute and is rejected below, rather
  // than silently inheriting whatever scheme a base would supply.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    // Host allowlist, checked by EXACT match only. `.host` is WHATWG's own
    // parse of the authority — already lowercased, and (crucially) NOT the
    // attacker-supplied userinfo: `https://storage.googleapis.com@evil.com/x`
    // parses with `.host === 'evil.com'`, so the userinfo-spoofed prefix
    // never reaches this comparison at all.
    //
    // This must stay `===` (via Set membership) and never become `endsWith`,
    // `includes`, `startsWith`, or a regex on the host — a suffix check
    // would let both "evilstorage.googleapis.com" (wrong prefix) and
    // "storage.googleapis.com.evil.com" (allowed host as a *prefix* of an
    // attacker domain) through. Exact match rejects both.
    const allowedHosts = buildAllowedHosts()
    return allowedHosts.has(parsed.host.toLowerCase())
  } catch {
    return false
  }
}
