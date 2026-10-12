import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_IDS } from '@world-bingo/shared-types'
import { themeLogoFor } from './theme-logo'

describe('theme logo', () => {
  it('gives winner its shipped logo', () => {
    expect(themeLogoFor('winner')).toBe('/brands/winner/logo.png')
  })

  it('leaves arada on its uploaded logo or wordmark', () => {
    expect(themeLogoFor('arada')).toBeNull()
  })

  it('returns null for an unknown or missing theme', () => {
    expect(themeLogoFor('nope')).toBeNull()
    expect(themeLogoFor(undefined)).toBeNull()
  })

  it('points every shipped logo at a file that exists', () => {
    for (const id of THEME_IDS) {
      const path = themeLogoFor(id)
      if (path) expect(existsSync(join(__dirname, '..', 'public', path)), path).toBe(true)
    }
  })
})
