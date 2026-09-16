import { test, expect, type Page } from '@playwright/test'

/**
 * Phone (SMS) sign-in.
 *
 * Players sign in with a Firebase phone number and a 6-digit code; there is no
 * player password, and sign-up is the same flow (an unknown number gets an
 * account). See docs/firebase-auth.md.
 *
 * Everything up to "send code" is testable anywhere. Completing a sign-in needs
 * a **Firebase test phone number** — Authentication → Sign-in method → Phone →
 * "Phone numbers for testing" — which returns a fixed code with no SMS sent and
 * no quota spent. Set both env vars to run those tests:
 *
 *   E2E_FIREBASE_TEST_PHONE=0911000000
 *   E2E_FIREBASE_TEST_CODE=123456
 *
 * Without them the sign-in tests skip rather than fail: a run against a
 * deployment with no Firebase project configured should not look like a
 * regression.
 */
const TEST_PHONE = process.env.E2E_FIREBASE_TEST_PHONE
const TEST_CODE = process.env.E2E_FIREBASE_TEST_CODE
const canSignIn = !!TEST_PHONE && !!TEST_CODE

async function signInWithTestNumber(page: Page) {
    await page.goto('/auth/login')
    await page.locator('#phone').fill(TEST_PHONE!)
    await page.getByRole('button', { name: /send code/i }).click()

    await expect(page.locator('#code')).toBeVisible({ timeout: 20_000 })
    await page.locator('#code').fill(TEST_CODE!)
    await page.getByRole('button', { name: /verify and continue/i }).click()
}

// ─── The form ────────────────────────────────────────────────────────────────

test.describe('Sign-in page', () => {
    test('uses the auth layout, with no app header', async ({ page }) => {
        await page.goto('/auth/login')
        await expect(page.locator('header')).not.toBeVisible()
    })

    test('opens on the phone tab, with Telegram beside it', async ({ page }) => {
        await page.goto('/auth/login')
        await expect(page.locator('#phone')).toBeVisible()
        await expect(page.getByRole('button', { name: /telegram/i })).toBeVisible()
    })

    test('asks for a number before it asks for a code', async ({ page }) => {
        await page.goto('/auth/login')
        await expect(page.locator('#phone')).toBeVisible()
        await expect(page.locator('#code')).toHaveCount(0)
    })

    // The native `required` bubble is a tooltip with no DOM change, which
    // replay records as a dead click on a button the player thinks is broken.
    test('rejects an empty number inline, without a browser dialog', async ({ page }) => {
        let dialogFired = false
        page.on('dialog', () => { dialogFired = true })

        await page.goto('/auth/login')
        await page.getByRole('button', { name: /send code/i }).click()

        await expect(page.locator('.auth-error')).toBeVisible({ timeout: 8_000 })
        expect(dialogFired).toBe(false)
    })

    test('rejects a number Firebase would refuse, before sending anything', async ({ page }) => {
        await page.goto('/auth/login')
        await page.locator('#phone').fill('12345')
        await page.getByRole('button', { name: /send code/i }).click()

        await expect(page.locator('.auth-error')).toContainText(/valid/i, { timeout: 8_000 })
    })

    test('switches to the Telegram tab and back', async ({ page }) => {
        await page.goto('/auth/login')
        await page.getByRole('button', { name: /telegram/i }).click()
        await expect(page.getByRole('button', { name: /continue with telegram/i })).toBeVisible()

        await page.getByRole('button', { name: /^phone$/i }).click()
        await expect(page.locator('#phone')).toBeVisible()
    })

    test('links to the referral-code page', async ({ page }) => {
        await page.goto('/auth/login')
        await page.getByRole('link', { name: /enter it here/i }).click()
        await expect(page).toHaveURL(/\/auth\/register/)
    })

    test('sends a logged-out visitor on a protected route here', async ({ page }) => {
        await page.goto('/refer')
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 8_000 })
    })
})

// ─── Referral entry ──────────────────────────────────────────────────────────

test.describe('Register page', () => {
    test('is the same phone form, plus a referral field', async ({ page }) => {
        await page.goto('/auth/register')
        await expect(page.locator('#phone')).toBeVisible()
        await expect(page.getByRole('button', { name: /have a referral code/i })).toBeVisible()
    })

    test('pre-fills and reveals the code from ?ref=', async ({ page }) => {
        await page.goto('/auth/register?ref=TESTCODE')
        await expect(page.locator('#referralCode')).toHaveValue('TESTCODE')
    })

    test('links back to sign in', async ({ page }) => {
        await page.goto('/auth/register')
        await page.getByRole('link', { name: /sign in/i }).click()
        await expect(page).toHaveURL(/\/auth\/login/)
    })
})

// ─── A real sign-in ──────────────────────────────────────────────────────────

test.describe('Signing in with a Firebase test number', () => {
    test.skip(!canSignIn, 'set E2E_FIREBASE_TEST_PHONE and E2E_FIREBASE_TEST_CODE to run')

    test('a correct code lands the player in the lobby', async ({ page }) => {
        await signInWithTestNumber(page)
        await expect(page).toHaveURL('/', { timeout: 20_000 })
    })

    test('a wrong code shows an inline error and stays on the code step', async ({ page }) => {
        await page.goto('/auth/login')
        await page.locator('#phone').fill(TEST_PHONE!)
        await page.getByRole('button', { name: /send code/i }).click()

        await expect(page.locator('#code')).toBeVisible({ timeout: 20_000 })
        await page.locator('#code').fill('000000')
        await page.getByRole('button', { name: /verify and continue/i }).click()

        await expect(page.locator('.auth-error')).toBeVisible({ timeout: 15_000 })
        await expect(page.locator('#code')).toBeVisible()
    })

})
