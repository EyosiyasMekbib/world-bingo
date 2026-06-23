// apps/web/test/no-hardcoded-theme.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = [join(__dirname, '..', 'components', 'brand')]
const HEX = /#[0-9a-fA-F]{3,8}\b/
const FONT_FAMILY = /font-family\s*:/i

function vueFiles(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(vueFiles(p))
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('no hardcoded theme values in components', () => {
  const files = ROOTS.flatMap((r) => {
    try {
      return vueFiles(r)
    } catch {
      return []
    }
  })

  it('has no raw hex colors', () => {
    const offenders = files.filter((f) => HEX.test(readFileSync(f, 'utf8')))
    expect(offenders, `Use CSS tokens, not hex: ${offenders.join(', ')}`).toEqual([])
  })

  it('has no hardcoded font-family', () => {
    const offenders = files.filter((f) => FONT_FAMILY.test(readFileSync(f, 'utf8')))
    expect(offenders, `Use --font-* tokens: ${offenders.join(', ')}`).toEqual([])
  })
})
