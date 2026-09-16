import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('WithdrawalModal refusals', () => {
  const src = read('components/WithdrawalModal.vue')

  it("shows the api's reason through withdrawalErrorMessage", () => {
    expect(src).toContain("from '~/utils/withdrawal-error'")
    expect(src).toMatch(/error\.value = withdrawalErrorMessage\(e, t\)/)
    // The old order read `error` (the status name) before `message`.
    expect(src).not.toContain('e?.data?.error ?? e?.data?.message')
  })

  it.each(['withdrawalHoldAfterReset', 'withdrawalFailed'])(
    'wallet.%s is a non-empty string in both locales',
    (key) => {
      for (const locale of ['en', 'am']) {
        const value = JSON.parse(read(`i18n/locales/${locale}.json`)).wallet?.[key]
        expect(typeof value === 'string' && value.trim().length > 0, `${locale}.wallet.${key}`).toBe(true)
      }
    },
  )
})
