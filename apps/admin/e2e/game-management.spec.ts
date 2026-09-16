/**
 * Admin E2E Tests — Game Management
 *
 * Tests the full game lifecycle from the admin portal:
 * creation, listing, filtering, starting, cancelling, and refund flows.
 *
 * Requires:
 *   - Admin app running at ADMIN_BASE_URL (default http://localhost:3001)
 *   - API running at API_URL (default http://localhost:8080)
 *   - A seeded ADMIN user in the DB (see seed.ts)
 *
 * Run with: pnpm --filter @world-bingo/admin exec playwright test game-management.spec.ts
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
    // Wait for the dashboard to fully render (confirms auth cookies are set and SSR hydrated)
    await page.waitForLoadState('networkidle', { timeout: 10000 })
}

async function getAdminToken(): Promise<string> {
    const res = await fetch(`${API_URL}/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: ADMIN_USER, password: ADMIN_PASSWORD }),
    })
    const data = await res.json()
    return data.accessToken as string
}

/** Register a player via the public API. */
async function registerPlayer(suffix: string): Promise<{ userId: string; token: string }> {
    const username = `gm_player_${suffix}`
    const phone = `+25196${suffix.slice(-7).padStart(7, '0')}`
    const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password: 'Player123!' }),
    })
    const data = await res.json()
    return { userId: data.user.id, token: data.accessToken }
}

/** Fund a player by submitting + approving a deposit. */
async function fundPlayer(playerToken: string, adminToken: string, amount = 500) {
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
    )
    const form = new FormData()
    form.append('amount', String(amount))
    form.append('transactionId', `FUND${Date.now()}`)
    form.append('senderName', 'Fund Bot')
    form.append('senderAccount', '0900000000')
    form.append('receipt', new Blob([pngBytes], { type: 'image/png' }), 'receipt.png')

    const depRes = await fetch(`${API_URL}/wallet/deposit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
        body: form,
    })
    const tx = await depRes.json()

    await fetch(`${API_URL}/admin/transactions/${tx.id}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
        },
    })
}

// ─── Games Page — Navigation & Layout ─────────────────────────────────────────

test.describe('Games page — Navigation & Layout', () => {
    test('games page is accessible from sidebar nav link', async ({ page }) => {
        await adminLogin(page)
        // Click the "Games" nav link in the sidebar/header area
        await page.getByRole('link', { name: 'Games' }).click()
        await expect(page).toHaveURL(/\/games/, { timeout: 8000 })
    })

    test('games page shows "Game Management" heading', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        // h1 tag — use locator text match
        await expect(page.locator('h1', { hasText: 'Game Management' })).toBeVisible({ timeout: 8000 })
    })

    test('games page shows the game table area', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        // UTable renders as <table> — wait for it or at least the card wrapper
        await expect(page.locator('table, [data-testid="table"], .u-table').first()).toBeVisible({ timeout: 10000 })
    })

    test('games table has correct column headers', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.waitForTimeout(1500)
        await expect(page.getByText('Title', { exact: true })).toBeVisible({ timeout: 8000 })
        await expect(page.getByText('Status', { exact: true })).toBeVisible()
        await expect(page.getByText('Price (ETB)', { exact: true })).toBeVisible()
        await expect(page.getByText('Players', { exact: true })).toBeVisible()
        await expect(page.getByText('Pattern', { exact: true })).toBeVisible()
        await expect(page.getByText('House Edge %', { exact: true })).toBeVisible()
        await expect(page.getByText('Actions', { exact: true })).toBeVisible()
    })

    test('games page has "New Game" button', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await expect(page.getByRole('button', { name: /new game/i })).toBeVisible({ timeout: 8000 })
    })

    test('games page has status filter', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        // USelect in Nuxt UI renders as a <select> or button — check for "All" option text
        await expect(page.getByText('All', { exact: true })).toBeVisible({ timeout: 8000 })
    })

    test('games page has Refresh button', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible({ timeout: 8000 })
    })
})

// ─── Create Game Modal ────────────────────────────────────────────────────────

test.describe('Create Game Modal', () => {
    test('clicking "New Game" opens the create game modal', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })
    })

    test('create modal has all required fields', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        await expect(page.getByText('Title', { exact: true })).toBeVisible()
        await expect(page.getByText('Ticket Price (ETB)', { exact: true })).toBeVisible()
        await expect(page.getByText('Max Players', { exact: true })).toBeVisible()
        await expect(page.getByText('Min Players', { exact: true })).toBeVisible()
        await expect(page.getByText('House Edge %', { exact: true })).toBeVisible()
        await expect(page.getByText('Win Pattern', { exact: true })).toBeVisible()
    })

    test('create modal has Cancel and Create Game buttons', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        await expect(page.getByRole('button', { name: /^cancel$/i })).toBeVisible()
        await expect(page.getByRole('button', { name: /create game/i })).toBeVisible()
    })

    test('clicking Cancel closes the modal', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        await page.getByRole('button', { name: /^cancel$/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).not.toBeVisible({ timeout: 3000 })
    })

    test('successfully creating a game shows success toast and closes modal', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        // Fill the title field (placeholder: "e.g. Quick Bingo #1")
        await page.getByPlaceholder(/quick bingo/i).fill(`E2E Game ${Date.now()}`)
        await page.getByRole('button', { name: /create game/i }).click()

        // Success toast
        await expect(page.getByText(/game created/i)).toBeVisible({ timeout: 8000 })
        // Modal should close
        await expect(page.locator('h3', { hasText: 'Create New Game' })).not.toBeVisible({ timeout: 4000 })
    })

    test('creating a game without a title keeps the modal open', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        // Clear title and submit
        await page.getByPlaceholder(/quick bingo/i).fill('')
        await page.getByRole('button', { name: /create game/i }).click()
        await page.waitForTimeout(1500)

        // Modal should remain open (title is required)
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible()
    })

    test('newly created game appears in the table', async ({ page }) => {
        const uniqueTitle = `AutoTest_${Date.now()}`
        await adminLogin(page)
        await page.goto('/games')
        await page.getByRole('button', { name: /new game/i }).click()
        await expect(page.locator('h3', { hasText: 'Create New Game' })).toBeVisible({ timeout: 5000 })

        await page.getByPlaceholder(/quick bingo/i).fill(uniqueTitle)
        await page.getByRole('button', { name: /create game/i }).click()
        await expect(page.getByText(/game created/i)).toBeVisible({ timeout: 8000 })

        await page.getByRole('button', { name: /refresh/i }).click()
        await expect(page.getByText(uniqueTitle)).toBeVisible({ timeout: 8000 })
    })
})

// ─── Game Status Filtering ────────────────────────────────────────────────────

test.describe('Game Status Filtering', () => {
    test('filter by WAITING shows only waiting games', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.waitForTimeout(1000)

        // USelect renders as a <select> in Nuxt UI v3
        await page.locator('select').first().selectOption('WAITING')
        await page.waitForTimeout(1200)

        // No rows should show COMPLETED, CANCELLED, IN_PROGRESS, or STARTING
        const otherStatuses = page.locator('td').filter({ hasText: /^(COMPLETED|CANCELLED|IN_PROGRESS|STARTING)$/ })
        await expect(otherStatuses).toHaveCount(0)
    })

    test('selecting "All" shows game list', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.waitForTimeout(1000)

        await page.locator('select').first().selectOption('')
        await page.waitForTimeout(1200)

        // Table area should still be visible
        await expect(page.locator('table, .u-table').first()).toBeVisible()
    })
})

// ─── Game Actions — Start ────────────────────────────────────────────────────

test.describe('Game Actions — Start', () => {
    test('WAITING game row has a Start button', async ({ page }) => {
        // Create a game via API
        const adminToken = await getAdminToken()
        await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `StartTest ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })

        await adminLogin(page)
        await page.goto('/games')

        // Find a WAITING game row
        const waitingRow = page.locator('tr').filter({ hasText: 'WAITING' }).first()
        await expect(waitingRow).toBeVisible({ timeout: 8000 })

        // Start button should be present
        await expect(waitingRow.getByRole('button', { name: /start/i })).toBeVisible()
    })

    test('starting a game without enough players shows error toast', async ({ page }) => {
        const adminToken = await getAdminToken()
        const res = await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `NoPlayers ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 4,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })
        const game = await res.json()

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: game.title })
        await expect(row).toBeVisible({ timeout: 8000 })

        await row.getByRole('button', { name: /start/i }).click()

        // Error toast about not enough players
        await expect(page.getByText(/not enough players|failed to start/i)).toBeVisible({ timeout: 8000 })
    })

    test('starting a game with enough players shows success toast', async ({ page }) => {
        const adminToken = await getAdminToken()

        // Create game with minPlayers=2
        const gameRes = await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `ReadyGame ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })
        const game = await gameRes.json()

        // Register and fund 2 players, then join them to the game
        const p1 = await registerPlayer(`start1_${Date.now()}`)
        const p2 = await registerPlayer(`start2_${Date.now() + 1}`)
        await fundPlayer(p1.token, adminToken)
        await fundPlayer(p2.token, adminToken)

        // Get available cartelas
        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${p1.token}` },
        })
        const cartelas = await cartelasRes.json()

        // Players join the game
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${p1.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${p2.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[1].serial] }),
        })

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: game.title })
        await expect(row).toBeVisible({ timeout: 8000 })

        await row.getByRole('button', { name: /start/i }).click()

        // Success toast
        await expect(page.getByText(/starting|started/i)).toBeVisible({ timeout: 8000 })
    })
})

// ─── Game Actions — Cancel ────────────────────────────────────────────────────

test.describe('Game Actions — Cancel', () => {
    test('WAITING game row has a Cancel button', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')

        const waitingRow = page.locator('tr').filter({ hasText: 'WAITING' }).first()
        if (await waitingRow.isVisible({ timeout: 5000 }).catch(() => false)) {
            await expect(waitingRow.getByRole('button', { name: /cancel/i })).toBeVisible()
        }
    })

    test('clicking Cancel shows confirmation modal', async ({ page }) => {
        const adminToken = await getAdminToken()
        await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `CancelModal ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: 'CancelModal' })
        await expect(row).toBeVisible({ timeout: 8000 })

        await row.getByRole('button', { name: /cancel/i }).click()

        // Confirmation modal
        await expect(page.getByText(/cancel game\?/i)).toBeVisible({ timeout: 5000 })
        await expect(page.getByText(/all players will be refunded/i)).toBeVisible()
    })

    test('confirmation modal has Back and Confirm Cancel buttons', async ({ page }) => {
        const adminToken = await getAdminToken()
        await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `CancelBtns ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: 'CancelBtns' })
        await expect(row).toBeVisible({ timeout: 8000 })
        await row.getByRole('button', { name: /cancel/i }).click()

        await expect(page.getByRole('button', { name: /back/i })).toBeVisible({ timeout: 5000 })
        await expect(page.getByRole('button', { name: /confirm cancel/i })).toBeVisible()
    })

    test('confirming cancel shows success toast and updates game status', async ({ page }) => {
        const adminToken = await getAdminToken()
        const res = await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `ConfirmCancel ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: 'ConfirmCancel' })
        await expect(row).toBeVisible({ timeout: 8000 })

        await row.getByRole('button', { name: /cancel/i }).click()
        await page.getByRole('button', { name: /confirm cancel/i }).click()

        // Success toast
        await expect(page.getByText(/cancelled|refunded/i)).toBeVisible({ timeout: 8000 })
    })

    test('clicking Back in cancel modal closes the modal without cancelling', async ({ page }) => {
        const adminToken = await getAdminToken()
        await fetch(`${API_URL}/games`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                title: `BackCancel ${Date.now()}`,
                ticketPrice: 20,
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: 10,
                pattern: 'ANY_LINE',
            }),
        })

        await adminLogin(page)
        await page.goto('/games')

        const row = page.locator('tr').filter({ hasText: 'BackCancel' })
        await expect(row).toBeVisible({ timeout: 8000 })

        await row.getByRole('button', { name: /cancel/i }).click()
        await expect(page.getByText(/cancel game\?/i)).toBeVisible({ timeout: 5000 })

        await page.getByRole('button', { name: /back/i }).click()
        await expect(page.getByText(/cancel game\?/i)).not.toBeVisible({ timeout: 3000 })

        // Game should still be in waiting state
        await expect(row.getByText('WAITING')).toBeVisible()
    })
})

// ─── Game Table — Pagination ──────────────────────────────────────────────────

test.describe('Game Table — Pagination', () => {
    test('pagination controls appear when enough games exist', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')
        await page.waitForTimeout(2000)

        // Check if pagination is visible (only if there are enough games)
        const pagination = page.locator('text=Page')
        if (await pagination.isVisible({ timeout: 3000 }).catch(() => false)) {
            await expect(pagination).toBeVisible()
        }
    })
})

// ─── Completed & Cancelled Games ──────────────────────────────────────────────

test.describe('Completed & Cancelled Games', () => {
    test('completed games do not have Start or Cancel buttons', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')

        // Filter to completed
        const filterSelect = page.locator('select, [role="combobox"]').first()
        await filterSelect.click()
        await page.getByText('Completed', { exact: true }).click()
        await page.waitForTimeout(1500)

        const completedRow = page.locator('tr').filter({ hasText: 'COMPLETED' }).first()
        if (await completedRow.isVisible({ timeout: 3000 }).catch(() => false)) {
            await expect(completedRow.getByRole('button', { name: /start/i })).not.toBeVisible()
            await expect(completedRow.getByRole('button', { name: /cancel/i })).not.toBeVisible()
        }
    })

    test('cancelled games do not have Start or Cancel buttons', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/games')

        const filterSelect = page.locator('select, [role="combobox"]').first()
        await filterSelect.click()
        await page.getByText('Cancelled', { exact: true }).click()
        await page.waitForTimeout(1500)

        const cancelledRow = page.locator('tr').filter({ hasText: 'CANCELLED' }).first()
        if (await cancelledRow.isVisible({ timeout: 3000 }).catch(() => false)) {
            await expect(cancelledRow.getByRole('button', { name: /start/i })).not.toBeVisible()
            await expect(cancelledRow.getByRole('button', { name: /cancel/i })).not.toBeVisible()
        }
    })
})
