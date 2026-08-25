import { describe, it, expect } from 'vitest'
import { pickShell, FALLBACK_SHELL } from './pickShell'

const A_RAILS = { name: 'a-rails' }
const A_WIDE = { name: 'a-wide' }
const D_RAILS = { name: 'd-rails' }
const registry = {
  arada: { rails: A_RAILS, wide: A_WIDE },
  dash5: { rails: D_RAILS },
} as any

describe('pickShell', () => {
  it('returns the requested shell for the theme', () => {
    expect(pickShell(registry, 'arada', 'wide')).toBe(A_WIDE)
  })

  it('defaults to rails when no shell is requested', () => {
    expect(pickShell(registry, 'dash5', undefined)).toBe(D_RAILS)
    expect(FALLBACK_SHELL).toBe('rails')
  })

  it("falls back to the theme's own rails when it lacks the requested shell", () => {
    expect(pickShell(registry, 'dash5', 'wide')).toBe(D_RAILS)
  })

  it('falls back to arada when the theme is absent from the registry', () => {
    expect(pickShell(registry, 'nope' as any, 'wide')).toBe(A_WIDE)
  })

  it('never returns undefined', () => {
    expect(pickShell(registry, 'nope' as any, 'nope' as any)).toBe(A_RAILS)
  })
})
