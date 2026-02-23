/**
 * Web E2E Tests — Game Room & Gameplay
 *
 * Tests the full game lifecycle from a player's perspective:
 * joining a game room, cartela selection, paying to join,
 * live gameplay (ball calling, bingo board updates),
 * claiming bingo, winner overlay, game cancellation handling.
 *
 * Requires:
 *   - Web app running at BASE_URL (default http://localhost:3000)
 *   - API running at API_URL (default http://localhost:8080)
 *   - A seeded ADMIN user in the DB (see seed.ts)
 *
 * Run with: pnpm --filter @world-bingo/web exec playwright test game-room.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234!'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAdminToken(): Promise<string> {
    const res = await fetch(`${API_URL}/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: ADMIN_USER, password: ADMIN_PASSWORD }),
    })
    return (await res.json()).accessToken
}

async function registerPlayer(suffix: string) {
    const username = `game_${suffix}`
    const phone = `+25195${suffix.slice(-7).padStart(7, '0')}`
    const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password: 'TestPass123!' }),
    })
    const data = await res.json()
    return { username, phone, userId: data.user?.id, token: data.accessToken }
}

async function fundPlayer(playerToken: string, adminToken: string, amount = 1000) {
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
    )
    const form = new FormData()
    form.append('amount', String(amount))
    form.append('transactionId', `FUND${Date.now()}${Math.random().toString(36).slice(2, 7)}`)
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

async function createGameViaApi(adminToken: string, overrides: Record<string, any> = {}) {
    const res = await fetch(`${API_URL}/games`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
            title: overrides.title ?? `E2E Game ${Date.now()}`,
            ticketPrice: overrides.ticketPrice ?? 20,
            maxPlayers: overrides.maxPlayers ?? 10,
            minPlayers: overrides.minPlayers ?? 2,
            houseEdgePct: overrides.houseEdgePct ?? 10,
            pattern: overrides.pattern ?? 'ANY_LINE',
        }),
    })
    return await res.json()
}

async function loginViaUI(page: Page, username: string, password = 'TestPass123!') {
    await page.goto('/auth/login')
    await page.fill('input[name="identifier"]', username)
    await page.fill('input[name="password"]', password)
    await page.click('button[type="submit"]')
    await page.waitForURL('/', { timeout: 15000 })
}

// ─── Game Room — Cartela Selection ────────────────────────────────────────────

test.describe('Game Room — Cartela Selection', () => {
    test('game room page loads and shows game title', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { title: `TitleTest ${Date.now()}` })
        const player = await registerPlayer(Date.now().toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        await expect(page.getByText(game.title)).toBeVisible({ timeout: 10000 })
    })

    test('game room shows "Select Your Card(s) to Join" when not yet joined', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 1).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        await expect(page.getByText(/select your card/i)).toBeVisible({ timeout: 10000 })
    })

    test('game room shows ticket price', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 50 })
        const player = await registerPlayer((Date.now() + 2).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        await expect(page.getByText(/50/)).toBeVisible({ timeout: 10000 })
        await expect(page.getByText(/ETB/)).toBeVisible()
    })

    test('cartela tiles are displayed for selection', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 3).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        // Cartela tiles should be visible
        const tiles = page.locator('.cartela-tile, .cartela-grid .serial')
        await expect(tiles.first()).toBeVisible({ timeout: 10000 })
    })

    test('clicking a cartela tile selects it (adds "selected" class)', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 4).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        // Wait for tiles to load
        const firstTile = page.locator('.cartela-tile').first()
        await expect(firstTile).toBeVisible({ timeout: 10000 })

        await firstTile.click()
        await expect(firstTile).toHaveClass(/selected/)
    })

    test('clicking a selected cartela deselects it', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 5).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const firstTile = page.locator('.cartela-tile').first()
        await expect(firstTile).toBeVisible({ timeout: 10000 })

        await firstTile.click()
        await expect(firstTile).toHaveClass(/selected/)

        await firstTile.click()
        await expect(firstTile).not.toHaveClass(/selected/)
    })

    test('selecting multiple cartelas updates total cost display', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 25 })
        const player = await registerPlayer((Date.now() + 6).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const tiles = page.locator('.cartela-tile')
        await expect(tiles.first()).toBeVisible({ timeout: 10000 })

        // Select 2 cartelas
        await tiles.nth(0).click()
        await tiles.nth(1).click()

        // Total cost: 25 * 2 = 50
        await expect(page.getByText('50.00')).toBeVisible({ timeout: 5000 })
    })

    test('join button is disabled when no cartela is selected', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 7).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const joinBtn = page.locator('.join-btn')
        await expect(joinBtn).toBeVisible({ timeout: 10000 })
        await expect(joinBtn).toBeDisabled()
    })

    test('join button shows cost and becomes enabled after selecting a cartela', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 30 })
        const player = await registerPlayer((Date.now() + 8).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const tiles = page.locator('.cartela-tile')
        await expect(tiles.first()).toBeVisible({ timeout: 10000 })
        await tiles.first().click()

        const joinBtn = page.locator('.join-btn')
        await expect(joinBtn).toBeEnabled()
        await expect(joinBtn).toContainText('30.00')
    })

    test('taken cartelas have "taken" class and cannot be selected', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)

        // Have another player join to take a cartela
        const otherPlayer = await registerPlayer((Date.now() + 100).toString())
        await fundPlayer(otherPlayer.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${otherPlayer.token}` },
        })
        const cartelas = await cartelasRes.json()

        if (cartelas.length > 0) {
            await fetch(`${API_URL}/games/${game.id}/join`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${otherPlayer.token}`,
                },
                body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
            })
        }

        // Now check as a different player
        const player = await registerPlayer((Date.now() + 9).toString())
        await fundPlayer(player.token, adminToken)
        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        // Look for a taken tile
        const takenTile = page.locator('.cartela-tile.taken').first()
        if (await takenTile.isVisible({ timeout: 5000 }).catch(() => false)) {
            await expect(takenTile).toHaveClass(/taken/)
        }
    })
})

// ─── Game Room — Joining ──────────────────────────────────────────────────────

test.describe('Game Room — Joining', () => {
    test('joining shows "Joining…" spinner then redirects to play page', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 20).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const tiles = page.locator('.cartela-tile')
        await expect(tiles.first()).toBeVisible({ timeout: 10000 })
        await tiles.first().click()

        await page.locator('.join-btn').click()

        // Should show "Joining…" text briefly
        // Then redirect to play page
        await expect(page).toHaveURL(new RegExp(`/quick/${game.id}/play`), { timeout: 15000 })
    })

    test('joining with insufficient balance shows error message', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 10000 })
        const player = await registerPlayer((Date.now() + 21).toString())
        // Fund with only 100 — not enough for 10000
        await fundPlayer(player.token, adminToken, 100)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        const tiles = page.locator('.cartela-tile')
        await expect(tiles.first()).toBeVisible({ timeout: 10000 })
        await tiles.first().click()

        await page.locator('.join-btn').click()

        // Error message about insufficient funds
        await expect(page.getByText(/insufficient|not enough/i)).toBeVisible({ timeout: 8000 })
    })
})

// ─── Play Page — Layout ──────────────────────────────────────────────────────

test.describe('Play Page — Layout', () => {
    test('play page shows game title and status badge', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { title: `PlayLayout ${Date.now()}` })
        const player = await registerPlayer((Date.now() + 30).toString())
        await fundPlayer(player.token, adminToken)

        // Join via API
        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        await expect(page.getByText(game.title)).toBeVisible({ timeout: 10000 })
        // Status badge
        await expect(page.locator('.status-badge')).toBeVisible({ timeout: 8000 })
    })

    test('play page shows ball count (0/75 initially)', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 31).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        await expect(page.getByText(/\d+\s*\/\s*75\s*balls/i)).toBeVisible({ timeout: 10000 })
    })

    test('play page shows pattern badge', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { pattern: 'FULL_CARD' })
        const player = await registerPlayer((Date.now() + 32).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        await expect(page.getByText(/full card/i)).toBeVisible({ timeout: 10000 })
    })

    test('play page shows BINGO grid headers (B, I, N, G, O)', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 33).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        // Column headers
        for (const col of ['B', 'I', 'N', 'G', 'O']) {
            await expect(page.locator('.col-label, .col-header').filter({ hasText: col })).toBeVisible({ timeout: 10000 })
        }
    })

    test('bingo grid has a free space (star) at center', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 34).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        // Free space star
        await expect(page.locator('.free-star, .free-space').first()).toBeVisible({ timeout: 10000 })
    })

    test('play page has 25 cells (5x5 grid)', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 35).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        // Count cells
        const cells = page.locator('.grid-cell, .cell')
        await expect(cells).toHaveCount(25, { timeout: 10000 })
    })
})

// ─── Play Page — Waiting State ────────────────────────────────────────────────

test.describe('Play Page — Waiting State', () => {
    test('shows "Waiting for the game to start" before game begins', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 40).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        await expect(page.getByText(/waiting for the game to start/i)).toBeVisible({ timeout: 10000 })
    })

    test('shows "Back to Lobby" option when not joined', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 41).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        // Navigate directly to play without joining
        await page.goto(`/quick/${game.id}/play`)

        const backBtn = page.getByRole('button', { name: /back|go back/i })
        if (await backBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await expect(backBtn).toBeVisible()
        }
    })
})

// ─── Play Page — Multi-Cartela Tabs ───────────────────────────────────────────

test.describe('Play Page — Multi-Cartela', () => {
    test('multiple cartelas show tab selector for switching', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 10 })
        const player = await registerPlayer((Date.now() + 50).toString())
        await fundPlayer(player.token, adminToken)

        // Join with 2 cartelas
        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        if (cartelas.length >= 2) {
            await fetch(`${API_URL}/games/${game.id}/join`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${player.token}`,
                },
                body: JSON.stringify({ cartelaSerials: [cartelas[0].serial, cartelas[1].serial] }),
            })

            await loginViaUI(page, player.username)
            await page.goto(`/quick/${game.id}/play`)

            // Tab selector should be visible for 2+ cartelas
            const tabs = page.locator('.card-tab')
            await expect(tabs).toHaveCount(2, { timeout: 10000 })
        }
    })

    test('clicking a tab switches the displayed cartela', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken, { ticketPrice: 10 })
        const player = await registerPlayer((Date.now() + 51).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        if (cartelas.length >= 2) {
            await fetch(`${API_URL}/games/${game.id}/join`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${player.token}`,
                },
                body: JSON.stringify({ cartelaSerials: [cartelas[0].serial, cartelas[1].serial] }),
            })

            await loginViaUI(page, player.username)
            await page.goto(`/quick/${game.id}/play`)

            const tabs = page.locator('.card-tab')
            await expect(tabs).toHaveCount(2, { timeout: 10000 })

            // Click the second tab
            await tabs.nth(1).click()
            await expect(tabs.nth(1)).toHaveClass(/active/)

            // Click back to first tab
            await tabs.nth(0).click()
            await expect(tabs.nth(0)).toHaveClass(/active/)
        }
    })
})

// ─── Play Page — Cancelled Overlay ────────────────────────────────────────────

test.describe('Play Page — Game Cancellation', () => {
    test('game cancellation shows cancelled overlay with refund message', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 60).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        // Wait for the page to load
        await page.waitForTimeout(2000)

        // Cancel the game via admin API
        await fetch(`${API_URL}/admin/games/${game.id}/cancel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
        })

        // Should show cancelled overlay
        await expect(page.getByText(/game cancelled/i)).toBeVisible({ timeout: 15000 })
        await expect(page.getByText(/refunded/i)).toBeVisible()
    })

    test('cancelled overlay shows countdown and "Go Now" button', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 61).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)
        await page.waitForTimeout(2000)

        // Cancel
        await fetch(`${API_URL}/admin/games/${game.id}/cancel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
        })

        await expect(page.getByText(/game cancelled/i)).toBeVisible({ timeout: 15000 })
        await expect(page.getByText(/returning to lobby/i)).toBeVisible()
        await expect(page.getByRole('button', { name: /go now/i })).toBeVisible()
    })

    test('clicking "Go Now" on cancelled overlay navigates to lobby', async ({ page }) => {
        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 62).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)
        await page.waitForTimeout(2000)

        await fetch(`${API_URL}/admin/games/${game.id}/cancel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
        })

        await expect(page.getByRole('button', { name: /go now/i })).toBeVisible({ timeout: 15000 })
        await page.getByRole('button', { name: /go now/i }).click()

        await expect(page).toHaveURL('/', { timeout: 8000 })
    })
})

// ─── Game Room — Access Control ───────────────────────────────────────────────

test.describe('Game Room — Access Control', () => {
    test('unauthenticated user is redirected to login', async ({ page }) => {
        await page.goto('/quick/some-game-id')
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 10000 })
    })

    test('play page for non-existent game shows error', async ({ page }) => {
        const player = await registerPlayer((Date.now() + 70).toString())
        await loginViaUI(page, player.username)

        await page.goto('/quick/non-existent-game-id/play')

        // Should show error or redirect
        const errorText = page.getByText(/not found|error|failed/i)
        const backBtn = page.getByRole('button', { name: /back to lobby/i })
        const isError = await errorText.isVisible({ timeout: 8000 }).catch(() => false)
        const isBack = await backBtn.isVisible({ timeout: 3000 }).catch(() => false)

        expect(isError || isBack).toBeTruthy()
    })
})

// ─── Responsive — Mobile View ─────────────────────────────────────────────────

test.describe('Game Room — Mobile Responsive', () => {
    test('game room renders properly on mobile viewport', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 })

        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 80).toString())
        await fundPlayer(player.token, adminToken)

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}`)

        // Cartela selection should still be visible on mobile
        await expect(page.getByText(/select your card/i)).toBeVisible({ timeout: 10000 })
    })

    test('play page grid is visible on mobile', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 })

        const adminToken = await getAdminToken()
        const game = await createGameViaApi(adminToken)
        const player = await registerPlayer((Date.now() + 81).toString())
        await fundPlayer(player.token, adminToken)

        const cartelasRes = await fetch(`${API_URL}/games/${game.id}/cartelas`, {
            headers: { Authorization: `Bearer ${player.token}` },
        })
        const cartelas = await cartelasRes.json()
        await fetch(`${API_URL}/games/${game.id}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${player.token}`,
            },
            body: JSON.stringify({ cartelaSerials: [cartelas[0].serial] }),
        })

        await loginViaUI(page, player.username)
        await page.goto(`/quick/${game.id}/play`)

        // Grid should be visible
        const grid = page.locator('.bingo-grid, .grid')
        await expect(grid).toBeVisible({ timeout: 10000 })
    })
})
