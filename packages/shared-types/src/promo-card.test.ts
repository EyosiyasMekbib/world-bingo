import { describe, expect, it } from 'vitest'
import { PromoArtworkFieldsSchema, promoCardImageProblem } from './promo-card'

describe('promoCardImageProblem', () => {
  it('accepts the exact size and any other 3:1 export at or above the floor', () => {
    expect(promoCardImageProblem(900, 300)).toBeNull()
    expect(promoCardImageProblem(450, 150)).toBeNull()
    expect(promoCardImageProblem(1800, 600)).toBeNull()
  })

  it('rejects the wrong shape', () => {
    // 4:3 and 16:9 are the two shapes an uncropped source image usually is.
    expect(promoCardImageProblem(900, 675)).toMatch(/900×300/)
    expect(promoCardImageProblem(1600, 900)).toMatch(/3:1/)
  })

  it('rejects a right-shaped image that is too small to stay sharp', () => {
    expect(promoCardImageProblem(300, 100)).toMatch(/at least 450px/)
  })

  it('rejects unreadable dimensions', () => {
    expect(promoCardImageProblem(0, 0)).toMatch(/dimensions/)
  })
})

describe('PromoArtworkFieldsSchema', () => {
  it('coerces a multipart position string and defaults the alt text', () => {
    expect(PromoArtworkFieldsSchema.parse({ position: '3' })).toEqual({ altText: '', position: 3 })
  })

  it('treats an empty multipart position as unset', () => {
    expect(PromoArtworkFieldsSchema.parse({ altText: ' Cashback ', position: '' })).toEqual({
      altText: 'Cashback',
    })
  })

  it('rejects a position outside the orderable range', () => {
    expect(PromoArtworkFieldsSchema.safeParse({ position: '1000' }).success).toBe(false)
    expect(PromoArtworkFieldsSchema.safeParse({ position: '-1' }).success).toBe(false)
  })
})
