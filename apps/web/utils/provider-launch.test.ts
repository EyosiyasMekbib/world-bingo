import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { launchProviderFor } from './provider-launch'

describe('launchProviderFor', () => {
  it("uses the game's own provider code over the active provider", () => {
    expect(launchProviderFor({ providerCode: 'palace' }, 'atlasv')).toBe('palace')
  })

  it('falls back to the active provider when the game carries none', () => {
    expect(launchProviderFor({}, 'atlasv')).toBe('atlasv')
    // getGames() flattens a missing provider relation to null, not undefined.
    expect(launchProviderFor({ providerCode: null }, 'atlasv')).toBe('atlasv')
    expect(launchProviderFor({ providerCode: '' }, 'atlasv')).toBe('atlasv')
  })
})

const WEB = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(WEB, rel), 'utf8')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return vueFiles(full)
    return name.endsWith('.vue') ? [full] : []
  })
}

describe('provider game launch sites', () => {
  it("/games launches with the game's own provider code", () => {
    const src = read('pages/games/index.vue')
    expect(src).toMatch(
      /providerStore\.launchGame\(\s*launchProviderFor\(\s*game\s*,\s*providerStore\.activeProviderCode\s*\)\s*,\s*game\.gameCode\s*\)/,
    )
  })

  it("/games/[category] links to /play with the game's own provider code", () => {
    const src = read('pages/games/[category].vue')
    expect(src).toMatch(
      /:to="`\/play\/\$\{launchProviderFor\(\s*g\s*,\s*providerStore\.activeProviderCode\s*\)\}\/\$\{g\.gameCode\}`"/,
    )
  })

  it("the homepage feed links to /play with the card's own provider code", () => {
    const src = read('pages/index.vue')
    expect(src).toMatch(
      /to:\s*`\/play\/\$\{launchProviderFor\(\s*g\s*,\s*providerStore\.activeProviderCode\s*\)\}\/\$\{g\.gameCode\}`/,
    )
  })

  it('no page or component launches a game with only the active provider code', () => {
    const offenders = [...vueFiles(join(WEB, 'pages')), ...vueFiles(join(WEB, 'components'))]
      .filter((file) => {
        const src = readFileSync(file, 'utf8')
        return (
          /\/play\/\$\{\s*providerStore\.activeProviderCode\s*\}/.test(src) ||
          /launchGame\(\s*providerStore\.activeProviderCode\b/.test(src)
        )
      })
      .map((file) => relative(WEB, file))
    expect(offenders).toEqual([])
  })
})
