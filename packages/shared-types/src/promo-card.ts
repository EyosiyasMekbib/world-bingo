import { z } from 'zod'
import type {
  BonusRewardType,
  BonusRuleType,
  CashbackFrequency,
  CashbackRefundType,
  PromoKind,
} from './enums'

/**
 * Upload spec for the admin-managed promo tiles that sit under the lobby hero.
 * Unlike a hero banner this is a single image: the tile is 3:1 at every
 * breakpoint (225x75 on desktop, 300x100 on a phone, 342x114 when it goes full
 * width), so one file scales cleanly across all three and there is no mobile
 * variant to upload or to keep in sync.
 *
 * Because the shape never changes, the image is only ever scaled -- never
 * re-cropped. A 4:3 photo cannot be made to fit by trimming its sides without
 * cutting off whatever the promotion was trying to show, so the API rejects it
 * instead of guessing which half matters.
 */
export const PROMO_CARD_SPEC = {
  width: 900,
  height: 300,
  /** Below this the tile visibly softens on a 2x phone screen at full width. */
  minWidth: 450,
  /** Allowed relative deviation from the target aspect ratio. */
  ratioTolerance: 0.02,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxFileBytes: 1 * 1024 * 1024,
} as const

/** Why an image fails the spec, or null when it fits. */
export function promoCardImageProblem(width: number, height: number): string | null {
  if (!(width > 0) || !(height > 0)) return 'Could not read the image dimensions'
  const target = PROMO_CARD_SPEC.width / PROMO_CARD_SPEC.height
  const deviation = Math.abs(width / height - target) / target
  if (deviation > PROMO_CARD_SPEC.ratioTolerance) {
    return `The promo image must be ${PROMO_CARD_SPEC.width}×${PROMO_CARD_SPEC.height} (same 3:1 shape); got ${width}×${height}`
  }
  if (width < PROMO_CARD_SPEC.minWidth) {
    return `The promo image must be at least ${PROMO_CARD_SPEC.minWidth}px wide; got ${width}px`
  }
  return null
}

// Multipart fields arrive as strings, so an omitted position is an empty string
// rather than undefined -- treat it as "not set" and let the server pick. The
// inner schema has to be optional too: preprocess runs before it, so it is the
// one that sees the undefined this mapping produces.
const optionalPosition = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.coerce.number().int().min(0).max(999).optional(),
)

export const PromoArtworkFieldsSchema = z.object({
  altText: z.string().trim().max(160).default(''),
  position: optionalPosition.optional(),
})

export type PromoArtworkFields = z.infer<typeof PromoArtworkFieldsSchema>

/**
 * Admin view of one uploaded tile image. `refId` is whatever identifies the
 * thing being promoted for its `kind`: a CashbackPromotion id, a BonusRule id,
 * or the literal 'welcome' / 'referral' for the two settings-backed promos that
 * have no row to point at.
 */
export interface PromoArtworkDto {
  kind: PromoKind
  refId: string
  imageUrl: string
  altText: string
  position: number | null
}

/**
 * Lobby view of one promo tile, fully resolved for rendering. The API decides
 * the copy and the styling here rather than in the client, because the same
 * tile has to look identical in the web app, in the admin preview, and in any
 * future surface -- and because `figure`/`unit` depend on promotion internals
 * (percentage vs fixed reward) the client has no business re-deriving.
 */
export interface PublicPromotionDto {
  kind: PromoKind
  refId: string
  name: string
  /** The big metal number, e.g. '50' or '10'. */
  figure: string
  /** Sits beside the figure, e.g. 'ETB' or '% BACK'. */
  unit: string
  /** One supporting line under the figure. */
  sub: string
  /** Site path the tile links to. */
  href: string
  /** Which call-to-action chip to draw; null means a plain chevron. */
  action: 'deposit' | 'referral' | null
  /** Kicker colour family, so the tiles stay visually distinct in a row. */
  accent: 'amber' | 'cyan' | 'emerald' | 'rose'
  artwork: { imageUrl: string; altText: string } | null
  position: number
}

/**
 * How far a signed-in player is towards claiming one promotion. Kept separate
 * from PublicPromotionDto because the tile list is unauthenticated and cached;
 * progress is per-player and never is.
 */
export interface PromotionProgressDto {
  kind: PromoKind
  refId: string
  label: string
  current: number
  target: number
  hint: string
}

/**
 * The active cashback promotion, exactly as PromotionsService has always
 * returned it.
 */
export interface CashbackPromoSummary {
  name: string
  refundType: CashbackRefundType
  refundValue: number
  frequency: CashbackFrequency
}

/**
 * A deposit bonus rule, exactly as PromotionsService has always returned it.
 * DepositModal reads `threshold` off this to build its deposit hints.
 */
export interface DepositBonusSummary {
  name: string
  type: BonusRuleType
  threshold: number
  rewardType: BonusRewardType
  rewardValue: number
  maxReward: number | null
  validityHours: number
}

/**
 * The public promotions payload. `promotions` is the new tile list; the four
 * fields after it are the legacy shape PromotionsService already returns and
 * that DepositModal.vue already reads, kept byte-compatible so adding tiles
 * does not force a coordinated client change.
 */
export interface PromotionsPayload {
  promotions: PublicPromotionDto[]
  cashback: CashbackPromoSummary | null
  firstDepositBonus: number | null
  dailyDepositBonus: DepositBonusSummary | null
  weeklyDepositBonus: DepositBonusSummary | null
}
