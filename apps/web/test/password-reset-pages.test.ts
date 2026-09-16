import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('forced password change wiring', () => {
  it('the global middleware applies the redirect before letting public pages through', () => {
    const src = read('middleware/auth.global.ts')
    expect(src).toMatch(/passwordChangeRedirect\(/)
    // Public pages return early; a flagged player must be caught before that.
    expect(src.indexOf('passwordChangeRedirect(')).toBeLessThan(src.indexOf('if (isPublic) return'))
  })

  it('the set-password page exists, uses the auth layout and posts through the store', () => {
    expect(existsSync(join(ROOT, 'pages/set-password.vue'))).toBe(true)
    const src = read('pages/set-password.vue')
    expect(src).toMatch(/definePageMeta\(\s*\{[^}]*layout:\s*'auth'/)
    expect(src).toMatch(/auth\.changePassword\(/)
    expect(src).toMatch(/validateSetPasswordForm\(/)
    // Signing out must stay possible from the page that blocks everything else.
    expect(src).toMatch(/auth\.logout\(/)
  })

  it('the login page offers a "Forgot password?" route to support', () => {
    const src = read('pages/auth/login.vue')
    expect(src).toMatch(/t\('auth\.forgotPassword\.link'\)/)
    // Reuses the admin-configured support contact rather than a hardcoded one.
    expect(src).toMatch(/\/settings\/support/)
    expect(src).toMatch(/hasUsableContactChannel\(/)
  })
})

describe('password reset strings', () => {
  const en = JSON.parse(read('i18n/locales/en.json'))
  const am = JSON.parse(read('i18n/locales/am.json'))

  const leafKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object'
        ? leafKeys(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    )

  it.each(['setPassword', 'forgotPassword'])(
    'auth.%s exists in both locales with the same keys',
    (group) => {
      const enKeys = leafKeys(en.auth[group] ?? {})
      expect(enKeys.length).toBeGreaterThan(0)
      expect(leafKeys(am.auth[group] ?? {})).toEqual(enKeys)
    },
  )

  it.each(['setPassword', 'forgotPassword'])('no auth.%s string is left empty', (group) => {
    for (const locale of [en, am]) {
      for (const key of leafKeys(locale.auth[group])) {
        const value = key.split('.').reduce((o: any, k) => o[k], locale.auth[group])
        expect(typeof value === 'string' && value.trim().length > 0, key).toBe(true)
      }
    }
  })
})
