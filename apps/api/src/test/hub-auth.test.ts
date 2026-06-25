import { describe, it, expect } from 'vitest'
import { signBody, verifySignature } from '../gateways/hub/hub-auth.js'

describe('hub-auth', () => {
  const secret = 'shared-secret-123'
  const body = JSON.stringify({ providerCode: 'palace', method: 'launch' })

  it('verifies a signature it produced', () => {
    const sig = signBody(secret, body)
    expect(verifySignature(secret, body, sig)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = signBody(secret, body)
    expect(verifySignature(secret, body + 'x', sig)).toBe(false)
  })

  it('rejects a wrong secret', () => {
    const sig = signBody(secret, body)
    expect(verifySignature('other-secret', body, sig)).toBe(false)
  })

  it('rejects a malformed signature without throwing', () => {
    expect(verifySignature(secret, body, 'not-hex')).toBe(false)
    expect(verifySignature(secret, body, '')).toBe(false)
  })
})
