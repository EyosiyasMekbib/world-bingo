// packages/ui/src/theme/resolveBrand.test.ts
import { describe, expect, it } from 'vitest'
import { resolveBrand } from './resolveBrand'

describe('resolveBrand', () => {
  it('returns the requested brand', () => {
    expect(resolveBrand('arada').id).toBe('arada')
  })
  it('falls back to the default brand for an unknown id', () => {
    expect(resolveBrand('does-not-exist').id).toBe('arada')
  })
  it('falls back to the default brand for undefined', () => {
    expect(resolveBrand(undefined).id).toBe('arada')
  })
})
