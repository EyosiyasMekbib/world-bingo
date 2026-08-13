import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'

/**
 * Flat config for the monorepo.
 *
 * Formatting is NOT enforced here. Prettier already owns it (singleQuote, no
 * semi, trailingComma all, 4-space indent) via `pnpm format`, and duplicating
 * those rules in ESLint only produces two tools disagreeing about the same
 * line. ESLint's job in this repo is correctness: unused code, unsafe escapes,
 * accidental globals, Vue template mistakes.
 *
 * `no-undef` is deliberately off for TS and Vue files. TypeScript already
 * resolves identifiers, and in the Nuxt apps almost everything is auto-imported
 * (`ref`, `computed`, `useRoute`, `definePageMeta`, `useFetch`, …) — leaving
 * `no-undef` on there reports hundreds of false positives for symbols that
 * genuinely exist at build time. This is typescript-eslint's own guidance.
 */
export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/.nuxt/**',
            '**/.output/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/.turbo/**',
            '**/prisma/migrations/**',
            '**/public/**',
            '**/*.min.js',
        ],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...vue.configs['flat/recommended'],

    // ── TypeScript, everywhere ────────────────────────────────────────────────
    {
        files: ['**/*.{ts,mts,cts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: {
            'no-undef': 'off',
            // `_req`, `_reply`, `catch {}` placeholders are an established
            // convention in this codebase — see routes/settings/index.ts.
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
        },
    },

    // ── API: Node runtime ─────────────────────────────────────────────────────
    {
        files: ['apps/api/**/*.{ts,mts}'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },

    // ── Shared packages: library code, no runtime assumption ──────────────────
    {
        files: ['packages/**/*.{ts,mts,tsx}'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },

    // ── Nuxt apps: Vue SFCs ───────────────────────────────────────────────────
    {
        files: ['apps/web/**/*.vue', 'apps/admin/**/*.vue'],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tseslint.parser,
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
            globals: { ...globals.browser },
        },
        rules: {
            'no-undef': 'off',
            // Nuxt resolves pages and layouts by filename; requiring a
            // multi-word component name would mean renaming every route.
            'vue/multi-word-component-names': 'off',
            // Formatting-adjacent template rules Prettier already handles.
            'vue/max-attributes-per-line': 'off',
            'vue/singleline-html-element-content-newline': 'off',
            'vue/html-self-closing': 'off',
            'vue/html-indent': 'off',
            'vue/html-closing-bracket-newline': 'off',
            'vue/attributes-order': 'warn',
        },
    },

    // ── Nuxt apps: TS outside SFCs (stores, composables, plugins, config) ─────
    {
        files: ['apps/web/**/*.{ts,mts}', 'apps/admin/**/*.{ts,mts}'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
    },

    // ── Tests ─────────────────────────────────────────────────────────────────
    {
        files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**/*.ts', '**/e2e/**/*.ts'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            // Test doubles are legitimately loosely typed.
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },

    // ── Config files ──────────────────────────────────────────────────────────
    {
        files: ['**/*.config.{js,mjs,ts}', '**/*.cjs'],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
]
