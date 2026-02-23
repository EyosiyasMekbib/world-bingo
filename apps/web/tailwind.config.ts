import type { Config } from 'tailwindcss'

export default {
  content: [
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.{vue,js,ts}',
    './pages/**/*.{vue,js,ts}',
    './plugins/**/*.{js,ts}',
    './composables/**/*.{js,ts}',
    './app.vue',
    '../../packages/ui/src/**/*.{vue,js,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config
