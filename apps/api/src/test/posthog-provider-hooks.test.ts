import { describe, it, expect, vi, beforeEach } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { emitProviderLaunch, emitProviderBet, emitProviderWin } from '../lib/posthog-events'

// Third-party (Palace) play was invisible in PostHog beyond "launched": bets
// and wins happen inside the provider's iframe and only reach us as wallet
// callbacks. These emitters run post-commit in the wallet service so spend
// per game and per player becomes queryable.

beforeEach(() => vi.clearAllMocks())

describe('emitProviderLaunch', () => {
    it('captures provider_game_launched only for a usable launch', () => {
        emitProviderLaunch('u1', { providerCode: 'palace', gameCode: '214', launchOk: true })
        expect(captureEvent).toHaveBeenCalledWith('u1', 'provider_game_launched', {
            provider_code: 'palace',
            game_code: '214',
        })
    })

    it('captures provider_launch_failed with the reason when the launch is unusable', () => {
        emitProviderLaunch('u1', { providerCode: 'palace', gameCode: '214', launchOk: false, reason: 'bad_url' })
        expect(captureEvent).toHaveBeenCalledTimes(1)
        expect(captureEvent).toHaveBeenCalledWith('u1', 'provider_launch_failed', {
            provider_code: 'palace',
            game_code: '214',
            reason: 'bad_url',
        })
    })
})

describe('emitProviderBet', () => {
    it('captures provider_bet with the stake as a positive number', () => {
        emitProviderBet('u1', {
            providerCode: 'palace',
            gameCode: 'aviator',
            roundId: 'r-9',
            betId: 'b-1',
            amount: 25,
            spendAccount: 'REAL',
        })
        expect(captureEvent).toHaveBeenCalledWith('u1', 'provider_bet', {
            provider_code: 'palace',
            game_code: 'aviator',
            round_id: 'r-9',
            bet_id: 'b-1',
            amount: 25,
            spend_account: 'REAL',
        })
    })
})

describe('emitProviderWin', () => {
    it('captures provider_win with the payout and the round stake', () => {
        emitProviderWin('u1', {
            providerCode: 'palace',
            gameCode: 'aviator',
            roundId: 'r-9',
            betId: 'b-1',
            amount: 60,
            roundStake: 25,
        })
        expect(captureEvent).toHaveBeenCalledWith('u1', 'provider_win', {
            provider_code: 'palace',
            game_code: 'aviator',
            round_id: 'r-9',
            bet_id: 'b-1',
            amount: 60,
            round_stake: 25,
            net: 35,
        })
    })
})
