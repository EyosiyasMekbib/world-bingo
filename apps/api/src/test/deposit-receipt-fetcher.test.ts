import { describe, it, expect } from 'vitest'
import { classifyReceiptResponse } from '../services/deposit-verification/receipt-fetcher'

describe('classifyReceiptResponse', () => {
  it('flags a 429 as RATE_LIMITED', () => {
    const r = classifyReceiptResponse(429, 'application/json', '{"success":false,"message":"Rate limit exceeded"}')
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('flags a JSON rate-limit body even on 200', () => {
    const r = classifyReceiptResponse(
      200,
      'application/json',
      '{"success":false,"message":"Rate limit exceeded. Please try again later."}',
    )
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('treats 5xx as UNREACHABLE', () => {
    expect(classifyReceiptResponse(503, 'text/html', 'oops')).toEqual({ kind: 'unavailable', reason: 'UNREACHABLE' })
  })
  it('treats 404 as NOT_FOUND', () => {
    expect(classifyReceiptResponse(404, 'text/html', 'nope')).toEqual({ kind: 'unavailable', reason: 'NOT_FOUND' })
  })
  it('returns html for a 200 text/html receipt', () => {
    const r = classifyReceiptResponse(200, 'text/html', '<html>receipt</html>')
    expect(r).toEqual({ kind: 'html', html: '<html>receipt</html>' })
  })
})
