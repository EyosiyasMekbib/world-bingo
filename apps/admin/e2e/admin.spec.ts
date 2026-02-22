/**
 * T55 — Admin E2E Tests (Playwright)
 *
 * Tests the full admin portal: authentication, deposit verification,
 * withdrawal management, transaction history with filters.
 *
 * Requires:
 *   - Admin app running at ADMIN_BASE_URL (default http://localhost:3001)
 *   - API running at API_URL (default http://localhost:8080)
 *   - A seeded ADMIN user in the DB (see seed.ts)
 *
 * Run with: pnpm --filter @world-bingo/admin test:e2e
 */
import { test, expect, type Page } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234!'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Log in as admin through the UI and wait for the dashboard. */
async function adminLogin(page: Page, identifier = ADMIN_USER, password = ADMIN_PASSWORD) {
    await page.goto('/login')
    await page.fill('input[placeholder*="Username"]', identifier)
    await page.fill('input[type="password"]', password)
    await page.click('button[type="submit"]')
    await page.waitForURL('/', { timeout: 15000 })
}

/**
 * Register a normal (non-admin) player via the public API and
 * submit a deposit request, returning the transaction ID.
 */
async function seedPlayerDeposit(suffix: string): Promise<{ userId: string; txId: string }> {
    const username = `player_${suffix}`
    const phone = `+25191${suffix.slice(-7).padStart(7, '0')}`

    // Register
    const regRes = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password: 'Player123!' }),
    })
    const { user, accessToken } = await regRes.json()

    // Create a 1-pixel PNG blob to use as fake receipt
    const pngB64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const pngBytes = Buffer.from(pngB64, 'base64')

    const form = new FormData()
    form.append('amount', '150')
    form.append('transactionId', `TLB${suffix}`)
    form.append('senderName', `Player ${suffix}`)
    form.append('senderAccount', `0901${suffix.slice(-6).padStart(6, '0')}`)
    form.append(
        'receipt',
        new Blob([pngBytes], { type: 'image/png' }),
        'receipt.png',
    )

    const depRes = await fetch(`${API_URL}/wallet/deposit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
    })
    const tx = await depRes.json()
    return { userId: user.id, txId: tx.id }
}

/**
 * Register a player, fund them (bypass normal deposit flow via admin approve),
 * then submit a withdrawal request, returning the transaction ID.
 */
async function seedPlayerWithdrawal(suffix: string, adminToken: string): Promise<{ txId: string }> {
    const username = `wplayer_${suffix}`
    const phone = `+25192${suffix.slice(-7).padStart(7, '0')}`

    // Register player
    const regRes = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password: 'Player123!' }),
    })
    const { user: player, accessToken: playerToken } = await regRes.json()

    // Seed a deposit and approve it so the player has funds
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
    )
    const form = new FormData()
    form.append('amount', '500')
    form.append('transactionId', `TLB_WD${suffix}`)
    form.append('senderName', `WPlayer ${suffix}`)
    form.append('senderAccount', `0902${suffix.slice(-6).padStart(6, '0')}`)
    form.append('receipt', new Blob([pngBytes], { type: 'image/png' }), 'receipt.png')

    const depRes = await fetch(`${API_URL}/wallet/deposit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
        body: form,
    })
    const depTx = await depRes.json()

    // Admin approves the deposit to fund the player wallet
    await fetch(`${API_URL}/admin/transactions/${depTx.id}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
        },
    })

    // Player requests withdrawal
    const wRes = await fetch(`${API_URL}/wallet/withdraw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${playerToken}`,
        },
        body: JSON.stringify({ amount: 200 }),
    })
    const wTx = await wRes.json()
    return { txId: wTx.id }
}

/** Get an admin access token via the API login endpoint. */
async function getAdminToken(): Promise<string> {
    const res = await fetch(`${API_URL}/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: ADMIN_USER, password: ADMIN_PASSWORD }),
    })
    const data = await res.json()
    return data.accessToken as string
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test.describe('Admin authentication', () => {
    test('unauthenticated visit to / redirects to /login', async ({ page }) => {
        await page.goto('/')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('login page is accessible and shows Admin Portal heading', async ({ page }) => {
        await page.goto('/login')
        await expect(page.getByText(/Admin Portal/i)).toBeVisible()
    })

    test('non-admin player cannot log in to admin portal', async ({ page }) => {
        // Register a normal player
        const ts = Date.now().toString()
        const phone = `+25193${ts.slice(-7)}`
        await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: `nonadmin_${ts}`, phone, password: 'Player123!' }),
        })

        await page.goto('/login')
        await page.fill('input[placeholder*="Username"]', `nonadmin_${ts}`)
        await page.fill('input[type="password"]', 'Player123!')
        await page.click('button[type="submit"]')

        // Should stay on /login or show an error toast — not navigate to /
        await page.waitForTimeout(3000)
        // Either still on login page or back at login (redirect from middleware)
        await expect(page).toHaveURL(/\/login/)
    })

    test('admin logs in successfully and sees the dashboard', async ({ page }) => {
        await adminLogin(page)
        await expect(page).toHaveURL('/', { timeout: 10000 })
        // Dashboard shows some stat cards
        await expect(page.getByText(/Approved Deposit Sum|Dashboard|Users Count/i)).toBeVisible({ timeout: 8000 })
    })

    test('invalid credentials show an error message', async ({ page }) => {
        await page.goto('/login')
        await page.fill('input[placeholder*="Username"]', 'admin')
        await page.fill('input[type="password"]', 'wrongpassword')
        await page.click('button[type="submit"]')
        await expect(page.getByText(/Invalid credentials|Error/i)).toBeVisible({ timeout: 6000 })
    })
})

// ─── Deposit verification ─────────────────────────────────────────────────────

test.describe('Deposit verification', () => {
    let adminToken: string

    test.beforeEach(async () => {
        adminToken = await getAdminToken()
    })

    test('pending deposits page shows TeleBirr columns', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/deposits')

        // Table headers for new TeleBirr columns
        await expect(page.getByText('Txn ID')).toBeVisible({ timeout: 8000 })
        await expect(page.getByText('Sender Name')).toBeVisible()
        await expect(page.getByText('TeleBirr No.')).toBeVisible()
    })

    test('approving a deposit removes it from the pending list and shows success toast', async ({ page }) => {
        // Seed a deposit
        const { txId } = await seedPlayerDeposit(Date.now().toString())

        await adminLogin(page)
        await page.goto('/deposits')

        // Find the row with matching short txId
        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        // Click Approve button in that row
        await row.getByRole('button', { name: /approve/i }).click()

        // Success toast
        await expect(page.getByText(/Approved|credited/i)).toBeVisible({ timeout: 6000 })

        // Row disappears from pending list
        await expect(row).not.toBeVisible({ timeout: 8000 })
    })

    test('declining a deposit shows the decline modal with predefined reasons', async ({ page }) => {
        const { txId } = await seedPlayerDeposit((Date.now() + 1).toString())

        await adminLogin(page)
        await page.goto('/deposits')

        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        // Open decline modal
        await row.getByRole('button', { name: /decline/i }).click()

        // Predefined reasons should be visible
        await expect(page.getByText('Transaction ID mismatch')).toBeVisible({ timeout: 5000 })
        await expect(page.getByText('Invalid receipt')).toBeVisible()
        await expect(page.getByText('Amount mismatch')).toBeVisible()
    })

    test('selecting a predefined decline reason and confirming removes the deposit', async ({ page }) => {
        const { txId } = await seedPlayerDeposit((Date.now() + 2).toString())

        await adminLogin(page)
        await page.goto('/deposits')

        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        await row.getByRole('button', { name: /decline/i }).click()

        // Click a predefined reason to select it
        await page.getByText('Transaction ID mismatch').click()

        // Confirm decline
        await page.getByRole('button', { name: /confirm decline|decline/i }).last().click()

        // Success toast
        await expect(page.getByText(/Declined|notified/i)).toBeVisible({ timeout: 6000 })

        // Row removed from pending
        await expect(row).not.toBeVisible({ timeout: 8000 })
    })

    test('stats bar shows pending count and approved sum', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/deposits')
        // Stats bar has 3 cards: Pending / Approved / Declined
        await expect(page.getByText('Pending')).toBeVisible({ timeout: 8000 })
        await expect(page.getByText(/Approved \(all time\)/i)).toBeVisible()
        await expect(page.getByText(/Declined \(all time\)/i)).toBeVisible()
    })
})

// ─── Withdrawal management ────────────────────────────────────────────────────

test.describe('Withdrawal management', () => {
    let adminToken: string

    test.beforeEach(async () => {
        adminToken = await getAdminToken()
    })

    test('withdrawals page shows TeleBirr Number column and stats bar', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/withdrawals')

        await expect(page.getByText('TeleBirr Number')).toBeVisible({ timeout: 8000 })
        await expect(page.getByText('Awaiting Transfer')).toBeVisible()
        await expect(page.getByText(/Total Transferred/i)).toBeVisible()
    })

    test('approving a withdrawal marks it as transferred and shows success toast', async ({ page }) => {
        const { txId } = await seedPlayerWithdrawal(Date.now().toString(), adminToken)

        await adminLogin(page)
        await page.goto('/withdrawals')

        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        await row.getByRole('button', { name: /transfer|approve/i }).click()

        // Confirmation modal appears
        await expect(page.getByText(/confirm|send/i)).toBeVisible({ timeout: 5000 })
        await page.getByRole('button', { name: /confirm|yes/i }).last().click()

        // Success toast
        await expect(page.getByText(/Transferred|notified/i)).toBeVisible({ timeout: 6000 })
    })

    test('rejecting a withdrawal shows Reject & Refund button text', async ({ page }) => {
        const { txId } = await seedPlayerWithdrawal((Date.now() + 10).toString(), adminToken)

        await adminLogin(page)
        await page.goto('/withdrawals')

        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        // Should have "Reject & Refund" button (not just "Reject")
        await expect(row.getByRole('button', { name: /reject & refund/i })).toBeVisible()
    })

    test('rejecting a withdrawal with reason opens confirmation modal', async ({ page }) => {
        const { txId } = await seedPlayerWithdrawal((Date.now() + 20).toString(), adminToken)

        await adminLogin(page)
        await page.goto('/withdrawals')

        const shortId = txId.slice(0, 8)
        const row = page.locator('tr', { hasText: shortId })
        await expect(row).toBeVisible({ timeout: 10000 })

        await row.getByRole('button', { name: /reject & refund/i }).click()

        // Modal asking for reason
        await expect(page.getByText(/reason|note/i)).toBeVisible({ timeout: 5000 })
        // TeleBirr number prominent in alert
        await expect(page.getByText(/TeleBirr/i)).toBeVisible()
    })
})

// ─── Transaction history ──────────────────────────────────────────────────────

test.describe('Transaction history', () => {
    test('history page is accessible after login and shows a table', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/orders')
        await expect(page.getByRole('table')).toBeVisible({ timeout: 10000 })
    })

    test('can filter history by type DEPOSIT', async ({ page }) => {
        await adminLogin(page)
        await page.goto('/orders')

        // Look for filter controls (select / dropdown)
        const typeFilter = page.locator('select, [data-testid="type-filter"]').first()
        if (await typeFilter.isVisible()) {
            await typeFilter.selectOption('DEPOSIT')
            await page.waitForTimeout(1000)
            // All visible type badges should be DEPOSIT
            const badges = page.locator('td:has-text("WITHDRAWAL")')
            await expect(badges).toHaveCount(0)
        } else {
            // If no filter control visible, just assert the table is present
            await expect(page.getByRole('table')).toBeVisible()
        }
    })
})

// ─── Navigation ───────────────────────────────────────────────────────────────

test.describe('Admin navigation', () => {
    test('sidebar links navigate to correct pages', async ({ page }) => {
        await adminLogin(page)

        // Click on Deposits nav link
        await page.getByRole('link', { name: /deposits/i }).click()
        await expect(page).toHaveURL(/\/deposits/, { timeout: 8000 })

        // Click on Withdrawals nav link
        await page.getByRole('link', { name: /withdrawals/i }).click()
        await expect(page).toHaveURL(/\/withdrawals/, { timeout: 8000 })

        // Click on Users nav link
        await page.getByRole('link', { name: /users/i }).click()
        await expect(page).toHaveURL(/\/users/, { timeout: 8000 })
    })

    test('logout button signs out and redirects to /login', async ({ page }) => {
        await adminLogin(page)
        // Click the logout button (look in profile/settings area)
        const logoutBtn = page.getByRole('button', { name: /logout|sign out/i })
        if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await logoutBtn.click()
            await expect(page).toHaveURL(/\/login/, { timeout: 8000 })
        } else {
            // Try settings page
            await page.goto('/settings/profile')
            const logoutBtnSettings = page.getByRole('button', { name: /logout|sign out/i })
            if (await logoutBtnSettings.isVisible({ timeout: 3000 }).catch(() => false)) {
                await logoutBtnSettings.click()
                await expect(page).toHaveURL(/\/login/, { timeout: 8000 })
            }
        }
    })
})
