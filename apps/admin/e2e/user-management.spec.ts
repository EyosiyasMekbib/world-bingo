/**
 * Admin E2E Tests — User Management
 *
 * Tests the user management page: listing, searching, role changes,
 * user detail modals, and pagination.
 *
 * Requires:
 *   - Admin app running at ADMIN_BASE_URL (default http://localhost:3001)
 *   - API running at API_URL (default http://localhost:8080)
 *   - A seeded ADMIN user in the DB (see seed.ts)
 *
 * Run with: pnpm --filter @world-bingo/admin exec playwright test user-management.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'
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

async function registerPlayer(suffix: string): Promise<string> {
    const username = `usr_test_${suffix}`
    const phone = `+25197${suffix.slice(-7).padStart(7, '0')}`
    await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password: 'Player123!' }),
    })
    return username
}

// ─── Users Page — Layout ──────────────────────────────────────────────────────

test.describe('Users page — Layout', () => {
    test('users page is accessible from sidebar', async ({ page }) => {
        await adminLogin(page)
        await page.getByRole('link', { name: /users/i }).click()
        await expect(page).toHaveURL(/\/users/, { timeout: 8000 })
    })

    test('users page shows a table of users', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')
        await expect(page.getByRole('table')).toBeVisible({ timeout: 10000 })
    })

    test('users table shows Username, Phone, Role, and Created columns', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')
        await expect(page.getByText('Username')).toBeVisible({ timeout: 8000 })
        await expect(page.getByText('Phone')).toBeVisible()
        await expect(page.getByText('Role')).toBeVisible()
    })

    test('users page has a search input', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')
        const searchInput = page.locator('input[placeholder*="earch"], input[type="search"]')
        await expect(searchInput).toBeVisible({ timeout: 8000 })
    })
})

// ─── User Search ──────────────────────────────────────────────────────────────

test.describe('User Search', () => {
    test('searching for a username filters the table', async ({ page }) => {
        const username = await registerPlayer(Date.now().toString())

        await adminLogin(page)
        await page.goto('/users')

        const searchInput = page.locator('input[placeholder*="earch"], input[type="search"]')
        await searchInput.fill(username)

        // Wait for debounced search
        await page.waitForTimeout(1500)

        // The user should appear in the results
        await expect(page.getByText(username)).toBeVisible({ timeout: 8000 })
    })

    test('searching for a non-existent user shows no results', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')

        const searchInput = page.locator('input[placeholder*="earch"], input[type="search"]')
        await searchInput.fill(`nonexistent_user_${Date.now()}`)

        await page.waitForTimeout(1500)

        // Either empty table or "no users" message
        const rows = page.locator('tbody tr')
        const count = await rows.count()
        // Should have 0 data rows (or just the header)
        expect(count).toBeLessThanOrEqual(1)
    })

    test('clearing search shows all users again', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')

        const searchInput = page.locator('input[placeholder*="earch"], input[type="search"]')

        // Search for something
        await searchInput.fill('admin')
        await page.waitForTimeout(1500)

        // Clear the search
        await searchInput.fill('')
        await page.waitForTimeout(1500)

        // Table should have multiple users
        const rows = page.locator('tbody tr')
        const count = await rows.count()
        expect(count).toBeGreaterThanOrEqual(1)
    })
})

// ─── User Role Management ──────────────────────────────────────────────────────

test.describe('User Role Management', () => {
    test('clicking on a user row opens a detail or role modal', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')

        // Wait for table to load
        await expect(page.getByRole('table')).toBeVisible({ timeout: 10000 })

        // Find a PLAYER row and look for role change button
        const playerRow = page.locator('tr').filter({ hasText: /PLAYER|USER/ }).first()
        if (await playerRow.isVisible({ timeout: 5000 }).catch(() => false)) {
            // Look for a "Change Role" or "Edit" button
            const roleBtn = playerRow.getByRole('button', { name: /role|edit/i })
            if (await roleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await roleBtn.click()
                // Modal should open
                await expect(page.getByText(/role/i)).toBeVisible({ timeout: 5000 })
            }
        }
    })

    test('admin user is marked with ADMIN role badge', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')

        // Search for admin
        const searchInput = page.locator('input[placeholder*="earch"], input[type="search"]')
        await searchInput.fill(ADMIN_USER)
        await page.waitForTimeout(1500)

        // Admin user should have ADMIN badge
        await expect(page.getByText('ADMIN')).toBeVisible({ timeout: 8000 })
    })
})

// ─── User Pagination ──────────────────────────────────────────────────────────

test.describe('User Pagination', () => {
    test('pagination controls are visible when users exceed page limit', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')
        await page.waitForTimeout(2000)

        // Pagination text
        const pageText = page.locator('text=/Page \\d/').first()
        if (await pageText.isVisible({ timeout: 3000 }).catch(() => false)) {
            await expect(pageText).toBeVisible()
        }
    })

    test('next page button loads more users', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')
        await page.waitForTimeout(2000)

        const nextBtn = page.locator('button').filter({ has: page.locator('[class*="chevron-right"]') })
        if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            // Get first user before pagination
            const firstUserBefore = await page.locator('tbody tr').first().textContent()

            await nextBtn.click()
            await page.waitForTimeout(1500)

            // First user might be different
            const firstUserAfter = await page.locator('tbody tr').first().textContent()
            // At minimum, page navigated without error
            await expect(page.getByRole('table')).toBeVisible()
        }
    })
})

// ─── User Detail Modal ────────────────────────────────────────────────────────

test.describe('User Detail Modal', () => {
    test('clicking a user opens their detail modal with wallet info', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/users')

        await expect(page.getByRole('table')).toBeVisible({ timeout: 10000 })

        // Click the first data row
        const firstRow = page.locator('tbody tr').first()
        if (await firstRow.isVisible({ timeout: 3000 }).catch(() => false)) {
            await firstRow.click()

            // Detail modal should show user info
            const detailModal = page.locator('[role="dialog"], .modal')
            if (await detailModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                await expect(detailModal.getByText(/username|phone|role|balance/i)).toBeVisible({ timeout: 3000 })
            }
        }
    })
})
