/**
 * Flatten whatever a failed request rejected with into one shape the
 * `*_failed` analytics events can carry. ofetch throws several shapes
 * (FetchError with `data`/`status`, an AbortError/TimeoutError, a bare
 * TypeError when the network is down) and each page used to read a different
 * subset, so failures could not be grouped in PostHog. Never throws.
 */
export interface FailureInfo {
  /** HTTP status when the server answered, otherwise null. */
  status: number | null
  /** Stable, low-cardinality reason: the server's `code`, or one derived here. */
  code: string
  message: string
  timeout: boolean
}

function pickStatus(err: Record<string, any>): number | null {
  for (const candidate of [
    err.status,
    err.statusCode,
    err.response?.status,
    err.data?.statusCode,
  ]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return null
}

export function describeFailure(e: unknown): FailureInfo {
  const err = (e && typeof e === 'object' ? e : null) as Record<string, any> | null
  if (!err) return { status: null, code: 'unknown', message: '', timeout: false }

  const data = err.data && typeof err.data === 'object' ? err.data : null
  const message: string =
    typeof data?.message === 'string'
      ? data.message
      : typeof data?.error === 'string'
        ? data.error
        : typeof err.message === 'string'
          ? err.message
          : ''
  const status = pickStatus(err)
  const timeout =
    err.name === 'TimeoutError' ||
    err.cause?.name === 'TimeoutError' ||
    (typeof err.name === 'string' && /timeout/i.test(err.name)) ||
    (status === null && /timeout/i.test(message))

  let code: string
  if (typeof data?.code === 'string' && data.code) code = data.code
  else if (timeout) code = 'timeout'
  else if (status === 429) code = 'rate_limited'
  else if (status === 401 && /invalid credentials/i.test(message)) code = 'invalid_credentials'
  else if (status !== null) code = `http_${status}`
  else if (err.name === 'FetchError' || e instanceof TypeError || /fetch/i.test(message))
    code = 'network'
  else code = 'unknown'

  return { status, code, message, timeout }
}
