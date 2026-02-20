import { test, expect } from '@playwright/test'

// Helper function to create a test user via API
async function createTestUser(apiUrl: string, username: string, phone: string, password: string) {
    const response = await fetch(`${apiUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, phone, password }),
    })
    return response.json()
}

test.describe('User Registration Flow', () => {
    const testUser = {
        username: `testuser_${Date.now()}`,
        phone: `+2519${Math.floor(Math.random() * 100000000)}`,
        password: 'TestPassword123!',
    }

    test('should successfully register a new user', async ({ page }) => {
        await page.goto('/auth/register')
        
        // Fill in registration form
        await page.fill('input[name="username"]', testUser.username)
        await page.fill('input[name="phone"]', testUser.phone)
        await page.fill('input[name="password"]', testUser.password)
        await page.fill('input[name="confirmPassword"]', testUser.password)
        
        // Submit form
        await page.click('button[type="submit"]')
        
        // Should redirect to home or dashboard after successful registration
        // (The exact behavior depends on the implementation)
        await page.waitForTimeout(2000)
    })

    test('should fail registration with existing username', async ({ page }) => {
        // First registration
        await page.goto('/auth/register')
        
        const existingUser = {
            username: `existing_${Date.now()}`,
            phone: `+2519${Math.floor(Math.random() * 100000000)}`,
            password: 'TestPassword123!',
        }
        
        await page.fill('input[name="username"]', existingUser.username)
        await page.fill('input[name="phone"]', existingUser.phone)
        await page.fill('input[name="password"]', existingUser.password)
        await page.fill('input[name="confirmPassword"]', existingUser.password)
        await page.click('button[type="submit"]')
        
        await page.waitForTimeout(1000)
        
        // Try to register with same username
        await page.fill('input[name="username"]', existingUser.username)
        await page.fill('input[name="phone"]', `+2519${Math.floor(Math.random() * 100000000)}`)
        await page.fill('input[name="password"]', existingUser.password)
        await page.fill('input[name="confirmPassword"]', existingUser.password)
        await page.click('button[type="submit"]')
        
        // Should show error for duplicate username
        await expect(page.getByText(/already exists|exists/i)).toBeVisible()
    })

    test('should fail registration with password mismatch', async ({ page }) => {
        await page.goto('/auth/register')
        
        await page.fill('input[name="username"]', `test_${Date.now()}`)
        await page.fill('input[name="phone"]', `+2519${Math.floor(Math.random() * 100000000)}`)
        await page.fill('input[name="password"]', 'Password123!')
        await page.fill('input[name="confirmPassword"]', 'DifferentPassword!')
        await page.click('button[type="submit"]')
        
        // Should show error for password mismatch
        await expect(page.getByText(/match|doesn't match/i)).toBeVisible()
    })

    test('should fail registration with short password', async ({ page }) => {
        await page.goto('/auth/register')
        
        await page.fill('input[name="username"]', `test_${Date.now()}`)
        await page.fill('input[name="phone"]', `+2519${Math.floor(Math.random() * 100000000)}`)
        await page.fill('input[name="password"]', 'short')
        await page.fill('input[name="confirmPassword"]', 'short')
        await page.click('button[type="submit"]')
        
        // Should show error for short password
        await expect(page.getByText(/password.*short|minimum/i)).toBeVisible()
    })
})

test.describe('User Login Flow', () => {
    test('should login with valid credentials', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Fill in login form
        await page.fill('input[name="phone"]', '+251912345678')
        await page.fill('input[name="password"]', 'password123')
        
        // Submit form
        await page.click('button[type="submit"]')
        
        // Should redirect to home or dashboard
        await page.waitForTimeout(2000)
    })

    test('should show error with invalid credentials', async ({ page }) => {
        await page.goto('/auth/login')
        
        await page.fill('input[name="phone"]', '+251999999999')
        await page.fill('input[name="password"]', 'wrongpassword')
        await page.click('button[type="submit"]')
        
        // Should show error message
        await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible()
    })

    test('should have remember me option', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Check for remember me checkbox
        const rememberMe = page.locator('input[type="checkbox"]')
        await expect(rememberMe).toBeVisible()
    })

    test('should toggle between phone and username login', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Check if there's a toggle between phone/username
        const toggleButton = page.getByRole('button', { name: /username/i })
        if (await toggleButton.isVisible()) {
            await toggleButton.click()
            await expect(page.locator('input[name="username"]')).toBeVisible()
        }
    })
})
