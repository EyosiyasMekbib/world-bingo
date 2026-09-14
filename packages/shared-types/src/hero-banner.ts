import { z } from 'zod'

/**
 * Upload spec for admin-managed lobby hero banners. Every banner is a pair of
 * images — one per breakpoint — because a single ratio is either a sliver on a
 * phone or a wall on desktop. The dimensions match the arada banner art already
 * in apps/web/public/ads/hero (1440x300 desktop, 390x226 mobile at 1x).
 *
 * The API rejects uploads outside this spec, the admin pre-checks it before
 * uploading, and the lobby renders each image in a box of exactly this ratio.
 */
export const HERO_BANNER_SPEC = {
  desktop: { width: 1440, height: 300, minWidth: 1440 },
  mobile: { width: 780, height: 452, minWidth: 390 },
  /** Allowed relative deviation from the target aspect ratio. */
  ratioTolerance: 0.02,
  /** Viewports at or below this width get the mobile image. */
  mobileMaxWidthPx: 767,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxFileBytes: 5 * 1024 * 1024,
} as const

export type HeroBannerVariant = 'desktop' | 'mobile'

/** Why an image fails the spec, or null when it fits. */
export function heroBannerImageProblem(
  variant: HeroBannerVariant,
  width: number,
  height: number,
): string | null {
  const spec = HERO_BANNER_SPEC[variant]
  if (!(width > 0) || !(height > 0)) return 'Could not read the image dimensions'
  const target = spec.width / spec.height
  const deviation = Math.abs(width / height - target) / target
  if (deviation > HERO_BANNER_SPEC.ratioTolerance) {
    return `The ${variant} image must be ${spec.width}×${spec.height} (same shape); got ${width}×${height}`
  }
  if (width < spec.minWidth) {
    return `The ${variant} image must be at least ${spec.minWidth}px wide; got ${width}px`
  }
  return null
}

/** A site path like `/games` or an absolute https URL. Nothing else is clickable. */
export function isValidHeroBannerLink(link: string): boolean {
  // Browsers read a backslash as a slash, so "/\evil.com" is really "//evil.com".
  if (link.startsWith('/')) return !link.startsWith('//') && !/[\s\\]/.test(link)
  return /^https:\/\/[^\s/\\]+\.[^\s\\]+$/i.test(link)
}

export function isExternalHeroBannerLink(link: string): boolean {
  return /^https:\/\//i.test(link)
}

const bannerLink = z
  .string()
  .trim()
  .max(500)
  .refine(isValidHeroBannerLink, 'Link must be a site path like /games or an https:// URL')

// Multipart fields arrive as strings, so an empty link means "no link".
const optionalBannerLink = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  bannerLink.nullable(),
)

export const HeroBannerCreateFieldsSchema = z.object({
  altText: z.string().trim().max(160).default(''),
  linkUrl: optionalBannerLink.optional(),
})

export const HeroBannerUpdateSchema = z.object({
  altText: z.string().trim().max(160).optional(),
  linkUrl: optionalBannerLink.optional(),
  isActive: z.boolean().optional(),
})

export const HeroBannerReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})

export type HeroBannerCreateFields = z.infer<typeof HeroBannerCreateFieldsSchema>
export type HeroBannerUpdateDto = z.infer<typeof HeroBannerUpdateSchema>
export type HeroBannerReorderDto = z.infer<typeof HeroBannerReorderSchema>

/** Admin view: every banner, active or not. Dates are ISO strings on the wire. */
export interface HeroBannerDto {
  id: string
  desktopImageUrl: string
  mobileImageUrl: string
  altText: string
  linkUrl: string | null
  isActive: boolean
  position: number
  createdAt: string
  updatedAt: string
}

/** Lobby view: active banners only, already in display order. */
export interface PublicHeroBannerDto {
  id: string
  desktopImageUrl: string
  mobileImageUrl: string
  altText: string
  linkUrl: string | null
}
