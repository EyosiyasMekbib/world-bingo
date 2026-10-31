// apps/web/test/skin-hooks.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Shared pages theme themselves through var(--skin-x, <arada literal>). arada
// never defines --skin-*, so the fallback IS arada's look. A hook without a
// fallback would silently drop that property on arada.
const WEB = join(__dirname, '..')
const ROOTS = ['pages', 'components', 'layouts'].map((d) => join(WEB, d))

function vueFiles(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(vueFiles(p))
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('skin hooks', () => {
  const files = ROOTS.flatMap(vueFiles)

  it('always carry the arada value as a fallback', () => {
    const bare = files.filter((f) => /var\(--skin-[\w-]+\s*\)/.test(readFileSync(f, 'utf8')))
    expect(bare, `var(--skin-*) needs a fallback: ${bare.join(', ')}`).toEqual([])
  })

  it('are never defined by arada', () => {
    const arada = readFileSync(join(WEB, 'assets/css/themes/arada.css'), 'utf8')
    expect(arada).not.toMatch(/--skin-[\w-]+\s*:/)
  })

  it('are all defined by winner', () => {
    const used = new Set(
      files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/var\(--(skin-[\w-]+)/g)].map((m) => m[1])),
    )
    const winner = readFileSync(join(WEB, 'assets/css/themes/winner.css'), 'utf8')
    const missing = [...used].filter((v) => !new RegExp(`--${v}\\s*:`).test(winner))
    expect(missing).toEqual([])
  })
})
