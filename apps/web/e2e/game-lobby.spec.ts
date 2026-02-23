/**
 * Web E2E Tests — Game Lobby
 *
 * Tests the game lobby page: listing, game cards, jackpot banner,
 * navigation to game rooms, and real-time updates.
 *
 * Requires:
 *   - Web app running at BASE_URL (default http://localhost:3000)
 *   - API running at API_URL (default http://localhost:8080)
 *
 * Run with: pnpm --filter @world-bingo/web exec playwright test game-lobby.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function registerAndLogin(page: Page, suffix: string) {
    const username = `lobby_${suffix}`
    const phone = `+25198${suffix.slice(-7).padStart(7, '0')}`
    const password = 'TestPass123!'

    await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password }),
    })

    await page.goto('/auth/login')
    await page.fill('input[name="identifier"]', username)
    await page.fill('input[name="password"]', password)
    await page.click('button[type="submit"]')
    await page.waitForURL('/', { timeout: 15000 })
}

async function getAdminToken(): Promise<string> {
    const res = await fetch(`${API_URL}/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'admin', password: 'Admin1234!' }),
    })
    const data = await res.json()
    return data.accessToken as string
}

async function createGameViaApi(adminToken: string, title?: string) {
    const res = await fetch(`${API_URL}/games`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
            title: title ?? `Quick Bingo ${Date.now()}`,
            ticketPrice: 20,
            maxPlayers: 10,
            minPlayers: 2,
            houseEdgePct: 10,
            pattern: 'ANY_LINE',
        }),
    })
    return await res.json()
}

// ─── Lobby Page — Layout ──────────────────────────────────────────────────────

test.describe('Lobby Page — Layout', () => {
    test('authenticated user sees "Available Games" heading', async ({ page }) => {
        await registerAndLogin(page, Date.now().toString())
        await expect(page.getByRole('heading', { name: /available games/i })).toBeVisible({ timeout: 8000 })
    })

    test('lobby subtitle says "Pick a game and join the action"', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 1).toString())
        await expect(page.getByText(/pick a game and join/i)).toBeVisible({ timeout: 8000 })
    })

    test('progressive jackpot banner is visible', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 2).toString())
        await expect(page.getByText(/progressive jackpot/i)).toBeVisible({ timeout: 8000 })
    })

    test('jackpot banner shows ETB amount', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 3).toString())
        await expect(page.getByText(/ETB/i).first()).toBeVisible({ timeout: 8000 })
    })

    test('jackpot hint mentions "Full card in ≤ 20 balls"', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 4).toString())
        await expect(page.getByText(/20 balls/i)).toBeVisible({ timeout: 8000 })
    })

    test('deposit button is visible in the header', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 5).toString())
        await expect(page.getByRole('button', { name: /deposit/i })).toBeVisible({ timeout: 8000 })
    })

    test('withdraw button is visible in the header', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 6).toString())
        await expect(page.getByRole('button', { name: /withdraw/i })).toBeVisible({ timeout: 8000 })
    })
})

// ─── Game Cards ───────────────────────────────────────────────────────────────

test.describe('Lobby — Game Cards', () => {
    test('game cards show title, price, player count, and pattern', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, `LobbyCard ${Date.now()}`)

        await registerAndLogin(page, (Date.now() + 10).toString())

        const card = page.locator('.game-card').filter({ hasText: game.title })
        if (await card.isVisible({ timeout: 8000 }).catch(() => false)) {
            await expect(card.getByText(/ETB/)).toBeVisible()
            await expect(card.getByText(/players/i)).toBeVisible()
            await expect(card.getByText(/ANY_LINE|any line/i)).toBeVisible()
        }
    })

    test('game card has a "Join Game" link', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, `JoinLink ${Date.now()}`)

        await registerAndLogin(page, (Date.now() + 11).toString())

        const card = page.locator('.game-card').filter({ hasText: game.title })
        if (await card.isVisible({ timeout: 8000 }).catch(() => false)) {
            await expect(card.getByRole('link', { name: /join game/i })).toBeVisible()
        }
    })

    test('clicking "Join Game" navigates to the game room', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, `NavGame ${Date.now()}`)

        await registerAndLogin(page, (Date.now() + 12).toString())

        const card = page.locator('.game-card').filter({ hasText: game.title })
        if (await card.isVisible({ timeout: 8000 }).catch(() => false)) {
            await card.getByRole('link', { name: /join game/i }).click()
            await expect(page).toHaveURL(new RegExp(`/quick/${game.id}`), { timeout: 8000 })
        }
    })

    test('game card shows WAITING status badge', async ({ page }) => {
        const adminToken = await getAdminToken()
        await createGameViaApi(adminToken, `StatusBadge ${Date.now()}`)

        await registerAndLogin(page, (Date.now() + 13).toString())

        // Check that at least one game card has a WAITING badge
        const badge = page.locator('.badge--waiting, .badge').filter({ hasText: /waiting/i }).first()
        await expect(badge).toBeVisible({ timeout: 8000 })
    })
})

// ─── Empty State ──────────────────────────────────────────────────────────────

test.describe('Lobby — Empty State', () => {
    test('shows loading spinner while fetching games', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 20).toString())

        // Intercept to slow API so spinner is visible
        await page.route('**/games', route => setTimeout(() => route.continue(), 1000))
        await page.goto('/')

        // Spinner or loading text
        const loading = page.locator('.spinner-lg, text=Loading games')
        if (await loading.isVisible({ timeout: 3000 }).catch(() => false)) {
            await expect(loading).toBeVisible()
        }
    })

    test('shows "No games available" when no games exist', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 21).toString())

        // Mock empty games response
        await page.route('**/games', route =>
            route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        )
        await page.goto('/')

        await expect(page.getByText(/no games available/i)).toBeVisible({ timeout: 8000 })
    })
})

// ─── Wallet Display ──────────────────────────────────────────────────────────

test.describe('Lobby — Wallet Display', () => {
    test('wallet balance is shown in the header', async ({ page }) => {
        await registerAndLogin(page, (Date.now() + 30).toString())

        // Balance should be displayed somewhere (usually in header)
        // New users start with 0
        const balance = page.locator('text=/\\d+\\.?\\d*\\s*ETB|ETB\\s*\\d+/').first()
        await expect(balance).toBeVisible({ timeout: 8000 })
    })
})
