import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = join(__dirname, '..', 'pages')
const play = readFileSync(join(PAGES, 'play', '[providerCode]', '[gameCode].vue'), 'utf8')

describe('play page', () => {
  it('drives its states from the load reducer', () => {
    expect(play).toContain("from '~/utils/provider-load'")
  })

  it('keys the iframe by attempt so a retry replaces it', () => {
    expect(play).toMatch(/<iframe[\s\S]*?:key="load\.attempt"/)
  })

  it('offers a retry and reports timeouts and retries', () => {
    expect(play).toContain('@click="retry"')
    expect(play).toContain("track('provider_game_load_timeout'")
    expect(play).toContain("track('provider_game_retry'")
  })

  it('splits api time from frame time on provider_game_loaded', () => {
    expect(play).toMatch(/msToUrl: Math\.round\(next\.urlAt! - next\.startedAt\)/)
  })

  it('ignores a launch answer that belongs to an earlier attempt', () => {
    expect(play).toContain('attempt !== load.value.attempt')
  })
})
