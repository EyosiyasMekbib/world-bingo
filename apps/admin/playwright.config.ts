import { defineConfig, devices } from '@playwright/test'

/**
 * T55 — Admin Playwright E2E test configuration.
 * Admin app runs on port 3001; API on 8080.
 */
export default defineConfig({
    testDir: './e2e',
    fullyParallel: false, // run sequentially to avoid DB contention
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: 'html',
    use: {
        baseURL: process.env.ADMIN_BASE_URL || 'http://localhost:3001',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'pnpm --filter @world-bingo/admin dev',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
})
