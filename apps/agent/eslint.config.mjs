import root from '../../eslint.config.mjs'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'

/**
 * The monorepo's flat config, plus the two blocks it scopes by path.
 *
 * The root config names `apps/web/**` and `apps/admin/**` explicitly, so this
 * app inherits the shared rules but not the Vue parser or the browser globals,
 * and every SFC here would be handed to the TypeScript parser and reported as a
 * parse error. `turbo run lint` runs `eslint .` from each package directory, so
 * this file is what ESLint finds for apps/agent and the patterns below are
 * relative to it. It adds nothing new: the rules are the root config's own,
 * re-scoped to this app's files.
 */
export default [
  ...root,

  {
    ignores: ['.nuxt/**', '.output/**', 'node_modules/**', 'dist/**'],
  },

  // TS outside SFCs: composables, middleware, utils, config.
  {
    files: ['**/*.{ts,mts}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // Vue SFCs.
  {
    files: ['**/*.vue'],
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
]
