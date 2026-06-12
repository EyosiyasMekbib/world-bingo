import { describe, it, expect } from 'vitest'
import { BotService } from '../services/bot.service'

describe('BotService.shouldBotClaim', () => {
    it('always claims at 100% regardless of roll', () => {
        expect(BotService.shouldBotClaim(100, () => 0.999)).toBe(true)
        expect(BotService.shouldBotClaim(100, () => 0)).toBe(true)
    })

    it('never claims at 0%', () => {
        expect(BotService.shouldBotClaim(0, () => 0)).toBe(false)
        expect(BotService.shouldBotClaim(0, () => 0.001)).toBe(false)
    })

    it('claims when roll falls below the rate', () => {
        // rate 40 → claim iff roll < 0.40
        expect(BotService.shouldBotClaim(40, () => 0.39)).toBe(true)
        expect(BotService.shouldBotClaim(40, () => 0.40)).toBe(false)
        expect(BotService.shouldBotClaim(40, () => 0.99)).toBe(false)
    })

    it('treats null/undefined rate as 100 (legacy templates)', () => {
        expect(BotService.shouldBotClaim(null, () => 0.999)).toBe(true)
        expect(BotService.shouldBotClaim(undefined, () => 0.999)).toBe(true)
    })

    it('clamps out-of-range rates', () => {
        expect(BotService.shouldBotClaim(150, () => 0.999)).toBe(true)
        expect(BotService.shouldBotClaim(-10, () => 0)).toBe(false)
    })
})
