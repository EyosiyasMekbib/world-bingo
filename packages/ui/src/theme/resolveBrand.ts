// packages/ui/src/theme/resolveBrand.ts
import type { BrandTheme } from './types'
import { brands, DEFAULT_BRAND_ID } from './brands'

/**
 * Single seam for choosing the active brand. Today it reads from the in-repo
 * registry by id. To become admin/DB-editable later, replace the body with an
 * async fetch — callers and components do not change.
 */
export function resolveBrand(id: string | undefined): BrandTheme {
  if (id && brands[id]) return brands[id]
  if (id) console.warn(`[theme] unknown brand "${id}", falling back to ${DEFAULT_BRAND_ID}`)
  return brands[DEFAULT_BRAND_ID]
}
