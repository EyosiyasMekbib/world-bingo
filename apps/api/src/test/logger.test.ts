import { describe, it, expect } from 'vitest'
import { maskAccount, genReqId } from '../lib/logger.js'

describe('maskAccount', () => {
  it('masks the middle of a long account, keeping a recognizable head + tail', () => {
    expect(maskAccount('h00a053c60814bd4f569313abf1c3fa3d63')).toBe('h00a05…3d63')
  })
  it('mostly hides a short account/username', () => {
    expect(maskAccount('kira')).toBe('ki***')
    expect(maskAccount('Manager1')).toBe('Ma***')
  })
  it('renders empty/nullish as a sentinel', () => {
    expect(maskAccount('')).toBe('∅')
    expect(maskAccount(undefined as any)).toBe('∅')
  })
})

describe('genReqId', () => {
  it('honors an inbound x-request-id header', () => {
    expect(genReqId({ headers: { 'x-request-id': 'abc-123' } } as any)).toBe('abc-123')
  })
  it('mints a uuid when no header is present', () => {
    const id = genReqId({ headers: {} } as any)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
