import { describe, it, expect } from 'vitest'
import { describeFailure } from './http-failure'

// One shape for every "the request did not work" event the app tracks
// (login_failed, register_failed, deposit_checkout_failed,
// provider_launch_failed). ofetch rejects with several error shapes; this
// flattens them to { status, code, message, timeout } so the events can be
// grouped in PostHog without guessing.

describe('describeFailure', () => {
  it('uses the server error code when the body carries one', () => {
    const r = describeFailure({
      status: 403,
      data: { code: 'account_suspended', message: 'Suspended' },
    })
    expect(r).toEqual({
      status: 403,
      code: 'account_suspended',
      message: 'Suspended',
      timeout: false,
    })
  })

  it('reads statusCode and response.status as fallbacks for status', () => {
    expect(describeFailure({ statusCode: 429 }).status).toBe(429)
    expect(describeFailure({ response: { status: 502 } }).status).toBe(502)
  })

  it('maps 429 to rate_limited when the body has no code', () => {
    expect(describeFailure({ status: 429, data: { message: 'Too many' } }).code).toBe(
      'rate_limited',
    )
  })

  it('maps the bare "Invalid credentials" 401 to invalid_credentials', () => {
    const r = describeFailure({ status: 401, data: { message: 'Invalid credentials' } })
    expect(r.code).toBe('invalid_credentials')
    expect(r.message).toBe('Invalid credentials')
  })

  it('falls back to http_<status> for an uncoded server error', () => {
    expect(describeFailure({ status: 500, data: { message: 'boom' } }).code).toBe('http_500')
  })

  it('recognises an ofetch timeout', () => {
    const r = describeFailure({
      name: 'TimeoutError',
      message: 'The operation was aborted due to timeout',
    })
    expect(r).toEqual({
      status: null,
      code: 'timeout',
      message: 'The operation was aborted due to timeout',
      timeout: true,
    })
    expect(describeFailure({ cause: { name: 'TimeoutError' }, message: 'x' }).timeout).toBe(true)
  })

  it('treats a status-less fetch error as network', () => {
    expect(describeFailure({ name: 'FetchError', message: 'fetch failed' }).code).toBe('network')
    expect(describeFailure(new TypeError('Failed to fetch')).code).toBe('network')
  })

  it('never throws on junk', () => {
    expect(describeFailure(null)).toEqual({
      status: null,
      code: 'unknown',
      message: '',
      timeout: false,
    })
    expect(describeFailure('nope').code).toBe('unknown')
  })
})

describe('describeFailure (ofetch timeout wrapping)', () => {
  it('treats a status-less FetchError whose message says timeout as a timeout', () => {
    // ofetch wraps the abort in a FetchError; the name is not TimeoutError.
    const r = describeFailure({
      name: 'FetchError',
      message: 'The operation was aborted due to timeout',
    })
    expect(r.timeout).toBe(true)
    expect(r.code).toBe('timeout')
  })
})
