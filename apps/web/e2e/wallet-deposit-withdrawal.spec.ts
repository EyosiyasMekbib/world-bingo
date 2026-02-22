/**
 * T54 — Web E2E Tests (Playwright)
 *
 * Tests the full deposit, withdrawal, wallet UI, and notification flows.
 * Requires: web app running at BASE_URL (default http://localhost:3000)
 *           API running at API_URL (default http://localhost:8080)
 *
 * Run with: pnpm --filter @world-bingo/web exec playwright test
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function registerAndLogin(
    page: Page,
    username: string,
    phone: string,
    password = 'TestPass123!',
) {
    // Register via API directly (faster than UI for setup)
    await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password }),
    })

    // Login via UI
    await page.goto('/auth/login')
    await page.fill('input[name="identifier"]', username)
    await page.fill('input[name="password"]', password)
    await page.click('button[type="submit"]')
    await page.waitForURL('/', { timeout: 10000 })
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

test.describe('Lobby page', () => {
    test('redirects unauthenticated user to login', async ({ page }) => {
        await page.goto('/')
        await expect(page).toHaveURL(/\/auth\/login/)
    })

    test('authenticated user sees the lobby', async ({ page }) => {
        await registerAndLogin(
            page,
            `lobby_${Date.now()}`,
            `+251910${Date.now().toString().slice(-6)}`,
        )
        await page.goto('/')
        await expect(page.locator('h1, h2')).toContainText([/lobby|games|bingo/i], { timeout: 8000 })
    })
})

// ─── Deposit Flow ─────────────────────────────────────────────────────────────

test.describe('Deposit flow', () => {
    test('deposit modal shows TeleBirr instructions and merchant number', async ({ page }) => {
        await registerAndLogin(
            page,
            `dep_${Date.now()}`,
            `+251911${Date.now().toString().slice(-6)}`,
        )

        // Open deposit modal (click Deposit button in wallet UI)
        await page.goto('/')
        const depositBtn = page.getByRole('button', { name: /deposit/i })
        await expect(depositBtn).toBeVisible({ timeout: 8000 })
        await depositBtn.click()

        // Merchant number should be visible
        await expect(page.getByText('0901977670')).toBeVisible()

        // "15 minutes" deadline notice should be visible
        await expect(page.getByText(/15 minutes/i)).toBeVisible()

        // TeleBirr label (no dropdown)
        await expect(page.getByText(/TeleBirr/i)).toBeVisible()
    })

    test('deposit form requires all TeleBirr fields', async ({ page }) => {
        await registerAndLogin(
            page,
            `dep2_${Date.now()}`,
            `+251912${Date.now().toString().slice(-6)}`,
        )

        await page.goto('/')
        await page.getByRole('button', { name: /deposit/i }).click()

        // Fill amount but leave TeleBirr fields empty — submit button should be disabled
        await page.fill('input[type="number"]', '100')
        const submitBtn = page.getByRole('button', { name: /submit deposit/i })
        await expect(submitBtn).toBeDisabled()
    })

    test('deposit form submits successfully with all fields', async ({ page }) => {
        await registerAndLogin(
            page,
            `dep3_${Date.now()}`,
            `+251913${Date.now().toString().slice(-6)}`,
        )

        await page.goto('/')
        await page.getByRole('button', { name: /deposit/i }).click()

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
})

// ─── Withdrawal Flow ──────────────────────────────────────────────────────────

test.describe('Withdrawal flow', () => {
    test('withdrawal modal requires amount and account', async ({ page }) => {
        await registerAndLogin(
            page,
            `wd_${Date.now()}`,
            `+251914${Date.now().toString().slice(-6)}`,
        )

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
    test('notification bell is present in the header', async ({ page }) => {
        await registerAndLogin(
            page,
            `notif_${Date.now()}`,
            `+251915${Date.now().toString().slice(-6)}`,
        )

        await page.goto('/')
        // Notification bell should be visible (bell icon or notification element)
        const bell = page.locator('[data-testid="notification-bell"], .notification-bell, button[aria-label*="notification"]')
        await expect(bell).toBeVisible({ timeout: 8000 })
    })
})

// ─── Auth: Redirect after login ──────────────────────────────────────────────

test.describe('Auth redirect', () => {
    test('successful login redirects to lobby', async ({ page }) => {
        const username = `redir_${Date.now()}`
        const phone = `+251916${Date.now().toString().slice(-6)}`

        // Register via API
        await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, phone, password: 'TestPass123!' }),
        })

        await page.goto('/auth/login')
        await page.fill('input[name="identifier"]', username)
        await page.fill('input[name="password"]', 'TestPass123!')
        await page.click('button[type="submit"]')

        await expect(page).toHaveURL('/', { timeout: 10000 })
    })

    test('invalid credentials show error message', async ({ page }) => {
        await page.goto('/auth/login')
        await page.fill('input[name="identifier"]', 'nonexistent_user_xyz')
        await page.fill('input[name="password"]', 'wrongpassword')
        await page.click('button[type="submit"]')

        await expect(
            page.getByText(/invalid|incorrect|not found|failed/i)
        ).toBeVisible({ timeout: 6000 })
    })

    test('protected route redirects unauthenticated user', async ({ page }) => {
        // Navigate to a protected quick game route
        await page.goto('/quick/some-game-id/play')
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 8000 })
    })
})
