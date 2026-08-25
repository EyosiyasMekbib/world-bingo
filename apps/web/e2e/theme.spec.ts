import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_BRAND, themes } from '@world-bingo/shared-types'

// Every test targets '/', which is ssr:false (see routeRules in nuxt.config).
// The brand fetch therefore happens in the browser and page.route can stub it.
// On an SSR route the fetch runs inside Nitro and is serialized into the
// payload, where route interception cannot reach it.
async function stubBrand(page: Page, themeId: 'arada' | 'dash5', tokens?: Record<string, string>) {
  await page.route('**/brand', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...DEFAULT_BRAND,
        themeId,
        tokens: { ...themes[themeId].defaultTokens, ...tokens },
      }),
    })
  })
}

test.describe('theme system', () => {
  test('arada renders its own chrome at 16px', async ({ page }) => {
    await stubBrand(page, 'arada')
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'arada')
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('16px')
    await expect(page.locator('.ab-shell')).toBeVisible()
  })

  test('dash5 renders three columns at 13px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await stubBrand(page, 'dash5')
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dash5')
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('13px')
    await expect(page.locator('.d5-rail')).toBeVisible()
    await expect(page.locator('.d5-aside')).toBeVisible()
  })

  test('dash5 collapses to one column on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await stubBrand(page, 'dash5')
    await page.goto('/')
    await expect(page.locator('.d5-rail')).toBeHidden()
    await expect(page.locator('.d5-aside')).toBeHidden()
  })

  test('brand colours override the theme palette', async ({ page }) => {
    await stubBrand(page, 'dash5', { brandPrimary: '#ff00ff' })
    await page.goto('/')
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
    )
    expect(primary).toBe('#ff00ff')
  })
})
