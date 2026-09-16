/**
 * T54 — Web E2E Tests (Playwright)
 *
 * Tests the full deposit, withdrawal, wallet UI, and notification flows.
 * Requires: web app running at BASE_URL (default http://localhost:3000)
 *           API running (default http://localhost:8080)
 *
 * Run with: pnpm --filter @world-bingo/web exec playwright test
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Signs in as the Firebase **test phone number** for this deployment.
 *
 * This used to register a throwaway player over the API and log in with a
 * password. Players have no password now — they sign in with an SMS code — so
 * the fixture is a test number configured in the Firebase console
 * (Authentication → Sign-in method → Phone → "Phone numbers for testing"),
 * which returns a fixed code with no SMS sent. See docs/firebase-auth.md.
 *
 *   E2E_FIREBASE_TEST_PHONE=0911000000
 *   E2E_FIREBASE_TEST_CODE=123456
 *
 * Every suite that needs a signed-in player skips without them, so a run
 * against a deployment with no Firebase project does not look like a
 * regression.
 */
const TEST_PHONE = process.env.E2E_FIREBASE_TEST_PHONE
const TEST_CODE = process.env.E2E_FIREBASE_TEST_CODE
const canSignIn = !!TEST_PHONE && !!TEST_CODE
const NO_SIGN_IN = 'set E2E_FIREBASE_TEST_PHONE and E2E_FIREBASE_TEST_CODE (see docs/firebase-auth.md)'

async function signIn(page: Page) {
    await page.goto('/auth/login')
    await page.locator('#phone').fill(TEST_PHONE!)
    await page.getByRole('button', { name: /send code/i }).click()

    await expect(page.locator('#code')).toBeVisible({ timeout: 20_000 })
    await page.locator('#code').fill(TEST_CODE!)
    await page.getByRole('button', { name: /verify and continue/i }).click()
    await page.waitForURL('/', { timeout: 20_000 })
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

test.describe('Lobby page', () => {
    test('redirects unauthenticated user to login', async ({ page }) => {
        await page.goto('/')
        await expect(page).toHaveURL(/\/auth\/login/)
    })

    test('authenticated user sees the lobby', async ({ page }) => {
        test.skip(!canSignIn, NO_SIGN_IN)
        await signIn(page)
        await page.goto('/')
        await expect(page.locator('h1, h2')).toContainText([/lobby|games|bingo/i], { timeout: 8000 })
    })
})

// ─── Deposit Flow ─────────────────────────────────────────────────────────────

/**
 * The deposit modal is a stack of method cards, collapsed to a Continue button.
 * The manual (receipt) form only exists once its card is expanded.
 */
async function openManualDepositCard(page: Page) {
    await page.getByRole('button', { name: /^continue$/i }).first().click()
    await expect(page.locator('input[placeholder*="Transaction ID"]')).toBeVisible()
}

test.describe('Deposit flow', () => {
    test.skip(!canSignIn, NO_SIGN_IN)

    test('deposit modal shows TeleBirr instructions and merchant number', async ({ page }) => {
        await signIn(page)

        // Open deposit modal (click Deposit button in wallet UI)
        await page.goto('/')
        const depositBtn = page.getByRole('button', { name: /deposit/i })
        await expect(depositBtn).toBeVisible({ timeout: 8000 })
        await depositBtn.click()

        await openManualDepositCard(page)

        // Merchant number should be visible
        await expect(page.getByText('0901977670')).toBeVisible()

        // "15 minutes" deadline notice should be visible
        await expect(page.getByText(/15 minutes/i)).toBeVisible()

        // TeleBirr label (no dropdown)
        await expect(page.getByText(/TeleBirr/i)).toBeVisible()
    })

    test('deposit form requires all TeleBirr fields', async ({ page }) => {
        await signIn(page)

        await page.goto('/')
        await page.getByRole('button', { name: /deposit/i }).click()
        await openManualDepositCard(page)

        // Fill amount but leave TeleBirr fields empty — submit button should be disabled
        await page.fill('input[type="number"]', '100')
        const submitBtn = page.getByRole('button', { name: /submit deposit/i })
        await expect(submitBtn).toBeDisabled()
    })

    test('deposit form submits successfully with all fields', async ({ page }) => {
        await signIn(page)

        await page.goto('/')
        await page.getByRole('button', { name: /deposit/i }).click()
        await openManualDepositCard(page)

        // Fill all required fields
        await page.fill('input[type="number"]', '200')
        await page.fill('input[placeholder*="Transaction ID"]', 'TLB20260222TEST')
        await page.fill('input[placeholder*="Full name"]', 'Test User')
        await page.fill('input[placeholder*="09"]', '0911234567')

        // Upload a fake receipt image (create a 1x1 PNG)
        const buffer = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64',
        )
        const fileInput = page.locator('input[type="file"]')
        await fileInput.setInputFiles({
            name: 'receipt.png',
            mimeType: 'image/png',
            buffer,
        })

        // Submit should now be enabled
        const submitBtn = page.getByRole('button', { name: /submit deposit/i })
        await expect(submitBtn).toBeEnabled()
    })

    test('hosted-checkout card redirects to the ZareCash payment page', async ({ page }) => {
        await signIn(page)

        // The seeded ZareCash method ships disabled, so serve the catalog with it
        // enabled — this test is about the card's behaviour, not the operator toggle.
        await page.route('**/api/payment-methods**', (route) =>
            route.fulfill({
                json: [
                    {
                        id: 'zc',
                        code: 'zarecash',
                        name: 'ZareCash',
                        type: 'DEPOSIT',
                        merchantName: null,
                        merchantAccount: null,
                        instructions: null,
                        icon: '⚡',
                        logoUrl: null,
                        gateway: 'zarecash',
                        hostedCheckout: true,
                        sortOrder: -1,
                    },
                ],
            }),
        )
        await page.route('**/api/wallet/deposit/checkout', (route) =>
            route.fulfill({ json: { url: 'https://api.zarecash.com/pay/e2e-token' } }),
        )

        await page.goto('/')
        await page.getByRole('button', { name: /deposit/i }).click()
        await page.fill('input[type="number"]', '500')
        await page.getByRole('button', { name: /^continue$/i }).first().click()

        await page.waitForURL(/api\.zarecash\.com\/pay\//, { timeout: 8000 })
    })
})

// ─── Withdrawal Flow ──────────────────────────────────────────────────────────

test.describe('Withdrawal flow', () => {
    test.skip(!canSignIn, NO_SIGN_IN)

    test('withdrawal modal requires amount and account', async ({ page }) => {
        await signIn(page)

        await page.goto('/')
        const wdBtn = page.getByRole('button', { name: /withdraw/i })
        await expect(wdBtn).toBeVisible({ timeout: 8000 })
        await wdBtn.click()

        // Submit should be disabled when fields are empty
        const submitBtn = page.getByRole('button', { name: /request withdrawal/i })
        await expect(submitBtn).toBeDisabled()
    })
})

// ─── Notification Bell ────────────────────────────────────────────────────────

test.describe('Notification bell', () => {
    test.skip(!canSignIn, NO_SIGN_IN)

    test('notification bell is present in the header', async ({ page }) => {
        await signIn(page)

        await page.goto('/')
        // Notification bell should be visible (bell icon or notification element)
        const bell = page.locator('[data-testid="notification-bell"], .notification-bell, button[aria-label*="notification"]')
        await expect(bell).toBeVisible({ timeout: 8000 })
    })
})

// ─── Auth: Redirect after login ──────────────────────────────────────────────

test.describe('Auth redirect', () => {
    // 'successful login redirects to lobby' and 'invalid credentials show error
    // message' lived here and drove the username/password form. That form is
    // gone; the SMS flow that replaced it is covered by auth.spec.ts.

    test('protected route redirects unauthenticated user', async ({ page }) => {
        // Navigate to a protected quick game route
        await page.goto('/quick/some-game-id/play')
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 8000 })
    })
})
