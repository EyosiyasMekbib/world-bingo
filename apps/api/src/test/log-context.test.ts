import { describe, it, expect } from 'vitest'
import { getLogger, runWithLogger } from '../lib/log-context.js'
import { rootLogger } from '../lib/logger.js'

describe('log-context', () => {
  it('returns rootLogger when no request context is active', () => {
    expect(getLogger()).toBe(rootLogger)
  })

  it('returns the bound logger inside runWithLogger, and restores after', () => {
    const fake = { info() {} } as any
    const inside = runWithLogger(fake, () => getLogger())
    expect(inside).toBe(fake)
    expect(getLogger()).toBe(rootLogger)
  })
})
