import { test, expect } from '@playwright/test'

const API_URL = process.env.API_URL || 'http://localhost:8080'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uniqueUser() {
    const ts = Date.now()
    return {
        username: `e2e_${ts}`,
        phone: `+25191${ts.toString().slice(-7)}`,
        password: 'TestPass123!',
    }
}

async function registerViaApi(user: { username: string; phone: string; password: string }) {
    await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
    })
}

// ─── Registration Flow ───────────────────────────────────────────────────────

test.describe('User Registration Flow', () => {
    test('register page uses auth layout (no header)', async ({ page }) => {
        await page.goto('/auth/register')
        // Default layout header should NOT be present on auth layout pages
        await expect(page.locator('header')).not.toBeVisible()
        // Brand link in auth layout should be present instead
        await expect(page.locator('.auth-brand')).toBeVisible()
    })

    test('register page has "Create account" heading', async ({ page }) => {
        await page.goto('/auth/register')
        await expect(page.getByRole('heading', { name: /create account/i })).toBeVisible()
    })

    test('all required fields are present', async ({ page }) => {
        await page.goto('/auth/register')
        await expect(page.locator('#username')).toBeVisible()
        await expect(page.locator('#phone')).toBeVisible()
        await expect(page.locator('#reg-password')).toBeVisible()
    })

    test('successful registration redirects to lobby', async ({ page }) => {
        const user = uniqueUser()
        await page.goto('/auth/register')
        await page.locator('#username').fill(user.username)
        await page.locator('#phone').fill(user.phone)
        await page.locator('#reg-password').fill(user.password)
        await page.getByRole('button', { name: /create account/i }).click()
        await expect(page).toHaveURL('/', { timeout: 15_000 })
    })

    test('duplicate username shows inline error', async ({ page }) => {
        const user = uniqueUser()
        await registerViaApi(user)

        await page.goto('/auth/register')
        await page.locator('#username').fill(user.username)
        await page.locator('#phone').fill(`+25192${Date.now().toString().slice(-7)}`)
        await page.locator('#reg-password').fill(user.password)
        await page.getByRole('button', { name: /create account/i }).click()
        await expect(page.locator('.auth-error')).toBeVisible({ timeout: 8_000 })
    })

    test('short password is rejected by server and shows error', async ({ page }) => {
        await page.goto('/auth/register')
        await page.locator('#username').fill(`short_${Date.now()}`)
        await page.locator('#phone').fill(`+25193${Date.now().toString().slice(-7)}`)
        // HTML5 minlength won't block submit here since we don't set it — server rejects it
        await page.locator('#reg-password').fill('abc')
        await page.getByRole('button', { name: /create account/i }).click()
        await expect(page.locator('.auth-error')).toBeVisible({ timeout: 8_000 })
    })

    test('referral code badge appears when code is entered', async ({ page }) => {
        await page.goto('/auth/register')
        await page.locator('#referral').fill('WB3FA29C')
        await expect(page.locator('.referral-badge')).toBeVisible()
    })

    test('referral code pre-fills from ?ref= query param', async ({ page }) => {
        await page.goto('/auth/register?ref=TESTCODE')
        const value = await page.locator('#referral').inputValue()
        expect(value.toUpperCase()).toBe('TESTCODE')
    })

    test('password show/hide toggle works', async ({ page }) => {
        await page.goto('/auth/register')
        const pw = page.locator('#reg-password')
        await expect(pw).toHaveAttribute('type', 'password')
        await page.locator('.toggle-pass').click()
        await expect(pw).toHaveAttribute('type', 'text')
    })

    test('submit button shows spinner during submission', async ({ page }) => {
        await page.goto('/auth/register')
        await page.route('**/auth/register', route => setTimeout(() => route.continue(), 800))
        await page.locator('#username').fill(`spin_${Date.now()}`)
        await page.locator('#phone').fill(`+25194${Date.now().toString().slice(-7)}`)
        await page.locator('#reg-password').fill('TestPass123!')
        await page.getByRole('button', { name: /create account/i }).click()
        await expect(page.locator('.spinner')).toBeVisible()
    })
})

// ─── Login Flow ──────────────────────────────────────────────────────────────

test.describe('User Login Flow', () => {
    test('login page uses auth layout (no header)', async ({ page }) => {
        await page.goto('/auth/login')
        await expect(page.locator('header')).not.toBeVisible()
        await expect(page.locator('.auth-brand')).toBeVisible()
    })

    test('login page has "Welcome back" heading', async ({ page }) => {
        await page.goto('/auth/login')
        await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
    })

    test('login with valid credentials redirects to lobby', async ({ page }) => {
        const user = uniqueUser()
        await registerViaApi(user)

        await page.goto('/auth/login')
        await page.locator('#identifier').fill(user.username)
        await page.locator('#password').fill(user.password)
        await page.getByRole('button', { name: /sign in/i }).click()
        await expect(page).toHaveURL('/', { timeout: 15_000 })
    })

    test('login with phone number works', async ({ page }) => {
        const user = uniqueUser()
        await registerViaApi(user)

        await page.goto('/auth/login')
        await page.locator('#identifier').fill(user.phone)
        await page.locator('#password').fill(user.password)
        await page.getByRole('button', { name: /sign in/i }).click()
        await expect(page).toHaveURL('/', { timeout: 15_000 })
    })

    test('invalid credentials show inline error (no alert())', async ({ page }) => {
        // Confirm no browser dialog fires
        let alertFired = false
        page.on('dialog', () => { alertFired = true })

        await page.goto('/auth/login')
        await page.locator('#identifier').fill('nobody_xyz')
        await page.locator('#password').fill('wrongpass')
        await page.getByRole('button', { name: /sign in/i }).click()

        await expect(page.locator('.auth-error')).toBeVisible({ timeout: 8_000 })
        expect(alertFired).toBe(false)
    })

    test('password show/hide toggle works', async ({ page }) => {
        await page.goto('/auth/login')
        const pw = page.locator('#password')
        await expect(pw).toHaveAttribute('type', 'password')
        await page.locator('.toggle-pass').click()
        await expect(pw).toHaveAttribute('type', 'text')
        await page.locator('.toggle-pass').click()
        await expect(pw).toHaveAttribute('type', 'password')
    })

    test('sign-in button is disabled while loading', async ({ page }) => {
        await page.goto('/auth/login')
        await page.route('**/auth/login', route => setTimeout(() => route.continue(), 1000))
        await page.locator('#identifier').fill('some_user')
        await page.locator('#password').fill('SomePass123!')
        const btn = page.getByRole('button', { name: /sign in/i })
        await btn.click()
        await expect(btn).toBeDisabled()
    })

    test('"Create one" link navigates to register', async ({ page }) => {
        await page.goto('/auth/login')
        await page.getByRole('link', { name: /create one/i }).click()
        await expect(page).toHaveURL(/\/auth\/register/)
    })

    test('navigating to protected route while logged out redirects to login', async ({ page }) => {
        await page.goto('/refer')
        await expect(page).toHaveURL(/\/auth\/login/, { timeout: 8_000 })
    })
})
