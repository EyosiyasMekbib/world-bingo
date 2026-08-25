import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            '~': resolve(__dirname, '.'),
            '@': resolve(__dirname, '.'),
            '@world-bingo/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
            '@world-bingo/ui': resolve(__dirname, '../../packages/ui/src'),
            '@world-bingo/game-logic': resolve(__dirname, '../../packages/game-logic/src/index.ts'),
        },
    },
    test: {
        environment: 'jsdom',
        include: ['**/*.test.ts', '**/*.spec.ts'],
        // e2e/ holds Playwright specs. They use @playwright/test, which throws
        // when collected by vitest ("test.describe() can only be called in a
        // test file"), so vitest reported 5 phantom failures on every run.
        // Playwright runs them via `pnpm test:e2e`.
        exclude: ['**/node_modules/**', '**/dist/**', '**/.nuxt/**', 'e2e/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
        globals: true,
    },
})
