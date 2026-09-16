import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ALLOWED is private to the composable, so read it from source. A name missing
// here still reaches PostHog but never the admin analytics page.
const src = readFileSync(join(__dirname, '..', 'composables', 'useAnalytics.ts'), 'utf8')
const block = src.match(/const ALLOWED = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
const allowed = new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]))

describe('/events allowlist', () => {
  it('parses the allowlist', () => {
    expect(allowed.has('lobby_view')).toBe(true)
  })

  it.each([
    'deposit_submit_blocked',
    'deposit_submit_failed',
    'forgot_password_opened',
    'password_changed',
    'password_change_failed',
    'provider_game_load_dismissed',
    'otp_requested',
  ])('includes %s', (name) => {
    expect(allowed.has(name)).toBe(true)
  })
})
