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

    // ── The ratchet ───────────────────────────────────────────────────────────
    // This config is being adopted onto a codebase that has never been linted,
    // so the first honest pass found 881 problems. Erroring on all of them means
    // `pnpm lint` can never go in CI, and a check that always fails gets ignored
    // — which is how the repo ended up with a lint script that had never run.
    //
    // So the two rules that make up 77% of the findings are warnings for now.
    // They are real debt and the counts are visible on every run; the intent is
    // to fix them in tranches and promote each back to 'error' as it reaches
    // zero, not to leave them here.
    {
        rules: {
            // 587 findings. Genuine typing debt, concentrated in the API's route
            // handlers and the admin's API composable. Fixing it properly means
            // typing request bodies, not sprinkling casts.
            '@typescript-eslint/no-explicit-any': 'warn',
            // 93 findings. Real dead code and unused imports — mechanical to fix
            // but touches too many files to bundle into the commit that turns
            // linting on.
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            // 18 findings, all @ts-ignore over @ts-expect-error. The codebase's
            // existing convention; worth converting, not worth blocking on.
            '@typescript-eslint/ban-ts-comment': 'warn',
            // 7 findings, all `let x = null` immediately reassigned in every
            // branch. That is a declare-then-assign, not a defect, and five of
            // the seven are inside wallet services — code where a cosmetic edit
            // buys nothing and risks something.
            'no-useless-assignment': 'warn',
            // 2 findings. Worth attaching `cause` when rethrowing, not worth
            // blocking a build over.
            'preserve-caught-error': 'warn',
            // 2 findings, both deliberate lazy requires.
            '@typescript-eslint/no-require-imports': 'warn',
        },
    },

    // ── Nuxt UI table slots ───────────────────────────────────────────────────
    // @nuxt/ui names its table cell slots `#user.serial-cell`. The dot parses as
    // a directive modifier, so `vue/valid-v-slot` rejects every one of them.
    // The rule is right about Vue's grammar and wrong about this library — the
    // markup is correct and cannot be written another way.
    {
        files: ['apps/admin/**/*.vue'],
        rules: { 'vue/valid-v-slot': 'off' },
    },

    // ── TypeScript, everywhere ────────────────────────────────────────────────
    {
        files: ['**/*.{ts,mts,cts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: {
            'no-undef': 'off',
            // no-unused-vars is configured once in the ratchet block above.
            // Repeating it here with 'error' silently overrode that, because a
            // later matching block wins — which is exactly the trap that makes
            // flat config confusing to debug.
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

    // ── Vue SFCs ──────────────────────────────────────────────────────────────
    // packages/ui ships SFCs too. Omitting it meant those files were handed to
    // the TS parser, which cannot read a <template>, and reported as parse
    // errors — a config gap that looked like seven broken components.
    {
        files: ['apps/web/**/*.vue', 'apps/admin/**/*.vue', 'packages/ui/**/*.vue'],
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

    // ── Plain JS / MJS ────────────────────────────────────────────────────────
    // Scripts, k6 load tests and the browser extension are plain JS, so unlike
    // the TS files `no-undef` genuinely applies to them — which means their
    // globals have to be declared or every `console.log` is an error. That was
    // the whole of the first pass's `no-undef` count.
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                // k6 injects these into load-test scripts.
                __ENV: 'readonly',
                __VU: 'readonly',
                __ITER: 'readonly',
                encoding: 'readonly',
                // MV3 extension APIs.
                chrome: 'readonly',
                browser: 'readonly',
            },
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
