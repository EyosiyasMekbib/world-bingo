import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = join(__dirname, '..', 'pages')

describe('page shell declarations', () => {
  it.each(['games/index.vue', 'games/[category].vue'])('%s opts into the wide shell', (rel) => {
    const src = readFileSync(join(PAGES, rel), 'utf8')
    expect(src).toMatch(/definePageMeta\(\s*\{[^}]*shell:\s*'wide'/)
  })
})
