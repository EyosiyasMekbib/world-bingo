import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AVIATOR_FALLBACK_PATH, aviatorDestination } from './aviator-launch'

describe('aviatorDestination', () => {
  it('forwards to the play page for the provider and code the API resolved', () => {
    expect(aviatorDestination({ providerCode: 'atlasv', gameCode: 'spribe_aviator' })).toBe(
      '/play/atlasv/spribe_aviator',
    )
  })

  it('escapes codes that would break the route', () => {
    expect(aviatorDestination({ providerCode: 'palace', gameCode: 'a/b' })).toBe(
      '/play/palace/a%2Fb',
    )
  })

  it('falls back to the Mini Games list when nothing usable came back', () => {
    expect(aviatorDestination(null)).toBe(AVIATOR_FALLBACK_PATH)
    expect(aviatorDestination(undefined)).toBe(AVIATOR_FALLBACK_PATH)
    expect(aviatorDestination({ providerCode: null, gameCode: 'x' })).toBe(AVIATOR_FALLBACK_PATH)
    expect(aviatorDestination({ providerCode: 'palace', gameCode: '' })).toBe(AVIATOR_FALLBACK_PATH)
  })
})

describe('Aviator entry points', () => {
  const WEB = join(__dirname, '..')
  const read = (rel: string) => readFileSync(join(WEB, rel), 'utf8')

  it.each([
    'components/shells/arada/RailsShell.vue',
    'components/shells/dash5/Chrome.vue',
    'components/shells/dash5/RailsShell.vue',
  ])('%s links its Aviator tab to /aviator, not a category list', (file) => {
    const src = read(file)
    const aviatorLinks =
      src.match(/<NuxtLink[^>]*>[^<]*Aviator|<NuxtLink[^>]*>\s*<svg[\s\S]*?<span>Aviator/g) ?? []
    expect(aviatorLinks.length).toBeGreaterThan(0)
    for (const link of aviatorLinks) expect(link).toContain('to="/aviator"')
  })
})
