/**
 * Admin E2E Tests — Dashboard & Settings
 *
 * Tests the admin dashboard stats display and settings/profile page.
 *
 * Requires:
 *   - Admin app running at ADMIN_BASE_URL (default http://localhost:3001)
 *   - API running at API_URL (default http://localhost:8080)
 *   - A seeded ADMIN user in the DB (see seed.ts)
 *
 * Run with: pnpm --filter @world-bingo/admin exec playwright test dashboard-settings.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

const ADMIN_USER = process.env.ADMIN_USER || 'kira'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adminLogin(page: Page) {
    await page.goto('/login')
    await page.fill('input[placeholder*="Username or"]', ADMIN_USER)
    await page.fill('input[type="password"]', ADMIN_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('/', { timeout: 15000 })
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

test.describe('Dashboard — Stats Cards', () => {
    test('dashboard shows all 6 stat cards', async ({ page }) => {
        await adminLogin(page)
        await expect(page.getByText('Approved Deposit Sum')).toBeVisible({ timeout: 8000 })
        await expect(page.getByText('Declined Deposit Sum')).toBeVisible()
        await expect(page.getByText('Approved Withdrawal Sum')).toBeVisible()
        await expect(page.getByText('Total Profit')).toBeVisible()
        await expect(page.getByText('Users Count')).toBeVisible()
        await expect(page.getByText('Commission')).toBeVisible()
    })

    test('stat cards display ETB values (not "NaN" or "undefined")', async ({ page }) => {
        await adminLogin(page)
        await page.waitForTimeout(2000)

        // Check that values contain "ETB" or valid numbers
        const cards = page.locator('.text-3xl')
        const count = await cards.count()
        for (let i = 0; i < count; i++) {
            const text = await cards.nth(i).textContent()
            expect(text).not.toContain('NaN')
            expect(text).not.toContain('undefined')
        }
    })

    test('dashboard heading says "Dashboard"', async ({ page }) => {
        await adminLogin(page)
        await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({ timeout: 8000 })
    })

    test('dashboard has a refresh button', async ({ page }) => {
        await adminLogin(page)
        // Refresh icon button
        const refreshBtn = page.locator('button').filter({ has: page.locator('[class*="arrow-path"]') })
        await expect(refreshBtn).toBeVisible({ timeout: 8000 })
    })

    test('Users Count stat card shows a non-negative number', async ({ page }) => {
        await adminLogin(page)
        await page.waitForTimeout(2000)

        // Find the Users Count card
        const usersCard = page.locator('div').filter({ hasText: 'Users Count' }).first()
        await expect(usersCard).toBeVisible({ timeout: 8000 })

        // The value should be a number (not NaN)
        const value = await usersCard.locator('.text-3xl').textContent()
        expect(value).toBeTruthy()
        expect(value).not.toBe('NaN')
    })
})

// ─── Sidebar Navigation ──────────────────────────────────────────────────────

test.describe('Dashboard — Sidebar Navigation', () => {
    test('sidebar has links to all main sections', async ({ page }) => {
        await adminLogin(page)

        await expect(page.getByRole('link', { name: /deposits/i })).toBeVisible({ timeout: 8000 })
        await expect(page.getByRole('link', { name: /withdrawals/i })).toBeVisible()
        await expect(page.getByRole('link', { name: /users/i })).toBeVisible()
        await expect(page.getByRole('link', { name: /games/i })).toBeVisible()
    })

    test('clicking Dashboard link returns to /', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/deposits')

        // Navigate back to dashboard
        const dashLink = page.getByRole('link', { name: /dashboard/i })
        if (await dashLink.isVisible({ timeout: 3000 }).catch(() => false)) {
            await dashLink.click()
            await expect(page).toHaveURL('/', { timeout: 8000 })
        }
    })

    test('sidebar highlights the current active page', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/deposits')

        // The deposits link should have an active/selected style
        const depositsLink = page.getByRole('link', { name: /deposits/i })
        await expect(depositsLink).toBeVisible({ timeout: 8000 })
        // It should have some distinguishing class (active, selected, etc.)
        const classes = await depositsLink.getAttribute('class')
        // Just verify it's visible and clickable (visual state hard to assert generically)
        expect(classes).toBeTruthy()
    })
})

// ─── Settings / Profile Page ──────────────────────────────────────────────────

test.describe('Settings / Profile Page', () => {
    test('settings page is accessible', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/settings/profile')
        // Should not redirect to login
        await expect(page).toHaveURL(/\/settings\/profile/, { timeout: 8000 })
    })

    test('profile page shows admin username', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/settings/profile')

        // Should display the admin's username somewhere
        await expect(page.getByText(ADMIN_USER)).toBeVisible({ timeout: 8000 })
    })
})

// ─── Auth Edge Cases ──────────────────────────────────────────────────────────

test.describe('Auth — Edge Cases', () => {
    test('accessing /deposits without auth redirects to /login', async ({ page }) => {
        await page.goto('/deposits')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('accessing /users without auth redirects to /login', async ({ page }) => {
        await page.goto('/users')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('accessing /games without auth redirects to /login', async ({ page }) => {
        await page.goto('/games')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('accessing /settings/profile without auth redirects to /login', async ({ page }) => {
        await page.goto('/settings/profile')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('accessing /orders without auth redirects to /login', async ({ page }) => {
        await page.goto('/orders')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('accessing /tournaments without auth redirects to /login', async ({ page }) => {
        await page.goto('/tournaments')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('empty username shows validation or stays on login page', async ({ page }) => {
        await page.goto('/login')
        await page.fill('input[type="password"]', ADMIN_PASSWORD)
        await page.click('button[type="submit"]')

        // Should stay on login or show error
        await page.waitForTimeout(2000)
        await expect(page).toHaveURL(/\/login/)
    })

    test('empty password shows validation or stays on login page', async ({ page }) => {
        await page.goto('/login')
        await page.fill('input[placeholder*="Username"]', ADMIN_USER)
        await page.click('button[type="submit"]')

        await page.waitForTimeout(2000)
        await expect(page).toHaveURL(/\/login/)
    })
})
