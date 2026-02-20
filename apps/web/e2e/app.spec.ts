import { test, expect } from '@playwright/test'

test.describe('Homepage', () => {
    test('should load the homepage successfully', async ({ page }) => {
        await page.goto('/')
        
        // Check that the page loads without critical errors
        await expect(page).toHaveTitle(/World Bingo/i)
    })

    test('should display header with logo', async ({ page }) => {
        await page.goto('/')
        
        // Check for header element
        const header = page.locator('header')
        await expect(header).toBeVisible()
    })

    test('should have working navigation links', async ({ page }) => {
        await page.goto('/')
        
        // Check navigation is present
        const nav = page.locator('nav')
        await expect(nav).toBeVisible()
    })
})

test.describe('Authentication', () => {
    test('should display login page', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Check for login form elements
        await expect(page.getByRole('heading', { name: /login/i })).toBeVisible()
        await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
    })

    test('should display register page', async ({ page }) => {
        await page.goto('/auth/register')
        
        // Check for register form elements
        await expect(page.getByRole('heading', { name: /register/i })).toBeVisible()
        await expect(page.getByRole('button', { name: /sign up/i })).toBeVisible()
    })

    test('should toggle between login and register', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Find and click register link
        const registerLink = page.getByRole('link', { name: /register/i })
        await registerLink.click()
        
        // Should be on register page
        await expect(page).toHaveURL(/register/)
        await expect(page.getByRole('heading', { name: /register/i })).toBeVisible()
    })

    test('should show validation errors for empty form submission', async ({ page }) => {
        await page.goto('/auth/login')
        
        // Submit empty form
        await page.getByRole('button', { name: /sign in/i }).click()
        
        // Check for validation messages
        await expect(page.getByText(/required/i).first()).toBeVisible()
    })
})

test.describe('Quick Bingo Game', () => {
    test('should navigate to quick bingo page', async ({ page }) => {
        // Navigate with a mock game ID
        await page.goto('/quick/test-game-id')
        
        // Page should load (may show error for invalid game ID, but page structure should be present)
        await expect(page.locator('main')).toBeVisible()
    })

    test('should display game room components', async ({ page }) => {
        await page.goto('/quick/test-game-id')
        
        // Check for game-related elements
        const gameContainer = page.locator('[class*="game"]')
        await expect(gameContainer).toBeVisible()
    })
})

test.describe('Responsive Design', () => {
    test('should be mobile responsive', async ({ page }) => {
        // Set mobile viewport
        await page.setViewportSize({ width: 375, height: 667 })
        
        await page.goto('/')
        
        // Page should still be functional on mobile
        await expect(page.locator('main')).toBeVisible()
    })

    test('should display hamburger menu on mobile', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 667 })
        
        await page.goto('/')
        
        // Mobile menu button should be visible
        const menuButton = page.locator('[class*="menu"]').first()
        await expect(menuButton).toBeVisible()
    })
})
