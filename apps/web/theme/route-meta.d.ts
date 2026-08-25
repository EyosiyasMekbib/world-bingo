import type { ShellKey } from '@world-bingo/shared-types'

declare module 'vue-router' {
  interface RouteMeta {
    /** Which layout shell this page wants. Defaults to 'rails'. */
    shell?: ShellKey
  }
}

export {}
