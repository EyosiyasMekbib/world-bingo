import { describe, it, expect } from 'vitest'
import {
    parseReconcileArgs,
    summarizeGames,
    analyzeRounds,
    diffAgainstPalace,
    type GameLedgerRow,
    type RoundLedgerRow,
} from '../lib/provider-round-reconciliation'

const NOW = new Date('2026-09-14T06:00:00.000Z')

describe('parseReconcileArgs', () => {
    it('parses a full command', () => {
        expect(
            parseReconcileArgs(['--since', '2026-08-31', '--until', '2026-09-14', '--game', 'aviator', '--palace', '--top', '5'], NOW),
        ).toEqual({
            since: new Date('2026-08-31T00:00:00.000Z'),
            until: new Date('2026-09-14T00:00:00.000Z'),
            provider: 'palace',
            game: 'aviator',
            palace: true,
            top: 5,
        })
    })

    it('defaults until to now, provider to palace and top to 20', () => {
        expect(parseReconcileArgs(['--since', '2026-09-01'], NOW)).toEqual({
            since: new Date('2026-09-01T00:00:00.000Z'),
            until: NOW,
            provider: 'palace',
            game: null,
            palace: false,
            top: 20,
        })
    })

    it('requires --since', () => {
        expect(() => parseReconcileArgs([], NOW)).toThrow(/--since is required/)
    })

    it('rejects a malformed date', () => {
        expect(() => parseReconcileArgs(['--since', '31-08-2026'], NOW)).toThrow(/YYYY-MM-DD/)
    })

    it('rejects an until before since', () => {
        expect(() => parseReconcileArgs(['--since', '2026-09-10', '--until', '2026-09-01'], NOW)).toThrow(/after --since/)
    })

    it('rejects providers other than palace', () => {
        expect(() => parseReconcileArgs(['--since', '2026-09-01', '--provider', 'atlasv'], NOW)).toThrow(/only palace/)
    })

    it('requires --game with --palace', () => {
        expect(() => parseReconcileArgs(['--since', '2026-09-01', '--palace'], NOW)).toThrow(/--palace needs --game/)
    })

    it('rejects a flag with no value', () => {
        expect(() => parseReconcileArgs(['--since', '2026-09-01', '--game', '--palace'], NOW)).toThrow(/--game needs a value/)
    })
})

describe('summarizeGames', () => {
    const row = (o: Partial<GameLedgerRow>): GameLedgerRow => ({
        gameCode: 'g',
        bets: 0,
        wagered: '0',
        rolledBackBets: 0,
        rolledBackStake: '0',
        failedBets: 0,
        wins: 0,
        nonzeroWins: 0,
        paid: '0',
        refunded: '0',
        ...o,
    })

    it('computes hold, the PostHog-comparable stake and zero-win share, sorted by wagered', () => {
        const out = summarizeGames([
            row({ gameCode: 'chicken-road', bets: 10, wagered: '100.00000000', wins: 4, nonzeroWins: 4, paid: '90.00000000' }),
            row({
                gameCode: 'aviator',
                bets: 20,
                wagered: '400.00000000',
                rolledBackBets: 1,
                rolledBackStake: '25.00000000',
                wins: 20,
                nonzeroWins: 5,
                paid: '100.00000000',
                refunded: '25.00000000',
            }),
        ])
        expect(out.map((g) => g.gameCode)).toEqual(['aviator', 'chicken-road'])
        expect(out[0]).toMatchObject({ wagered: 400, posthogComparableWagered: 425, paid: 100, refunded: 25, hold: 0.75, zeroWinShare: 0.75 })
        expect(out[1]).toMatchObject({ hold: 0.1, zeroWinShare: 0 })
    })

    it('reports a null hold for a game with no completed stake', () => {
        expect(summarizeGames([row({ gameCode: null, failedBets: 2 })])[0]).toMatchObject({
            gameCode: '(none)',
            hold: null,
            zeroWinShare: null,
            failedBets: 2,
        })
    })
})

describe('analyzeRounds', () => {
    const r = (o: Partial<RoundLedgerRow>): RoundLedgerRow => ({
        userId: 'u1',
        roundId: 'r',
        bets: 1,
        wagered: '10',
        rolledBackBets: 0,
        rolledBackStake: '0',
        wins: 1,
        paid: '0',
        ...o,
    })

    it('classifies rounds, players and stake buckets', () => {
        const a = analyzeRounds(
            [
                r({ userId: 'u1', roundId: 'r1', wagered: '40', paid: '60' }),
                r({ userId: 'u1', roundId: 'r2', wagered: '40', paid: '0' }),
                r({ userId: 'u2', roundId: 'r3', wagered: '250', wins: 0, paid: '0' }),
                r({ userId: 'u2', roundId: 'r4', bets: 0, wagered: '0', wins: 1, paid: '5' }),
                r({ userId: 'u2', roundId: 'r5', bets: 0, wagered: '0', rolledBackBets: 1, rolledBackStake: '30', wins: 0 }),
            ],
            10,
        )
        expect(a).toMatchObject({
            rounds: 3,
            paidRounds: 1,
            zeroWinRounds: 1,
            betWithoutWinRounds: 1,
            winWithoutBetRounds: 1,
            players: 2,
            playersNeverPaid: 1,
            netWinners: 0,
        })
        expect(a.topPlayers).toEqual([
            { userId: 'u2', rounds: 1, paidRounds: 0, wagered: 250, paid: 0, rtp: 0 },
            { userId: 'u1', rounds: 2, paidRounds: 1, wagered: 80, paid: 60, rtp: 0.75 },
        ])
        expect(a.stakeBuckets.find((b) => b.label === '<50')).toEqual({ label: '<50', rounds: 2, paidRounds: 1, wagered: 80, paid: 60, maxPaid: 60 })
        expect(a.stakeBuckets.find((b) => b.label === '200-499')).toEqual({ label: '200-499', rounds: 1, paidRounds: 0, wagered: 250, paid: 0, maxPaid: 0 })
    })

    it('limits topPlayers to top', () => {
        const rows = ['a', 'b', 'c'].map((u, i) => r({ userId: u, roundId: u, wagered: String(10 * (i + 1)) }))
        expect(analyzeRounds(rows, 2).topPlayers.map((p) => p.userId)).toEqual(['c', 'b'])
    })
})

describe('diffAgainstPalace', () => {
    const base = { rolledBackBets: 0, rolledBackStake: '0' }
    const ledger: RoundLedgerRow[] = [
        { ...base, userId: 'u1', roundId: 'r1', bets: 1, wagered: '10', wins: 1, paid: '15' },
        { ...base, userId: 'u1', roundId: 'r2', bets: 1, wagered: '20', wins: 1, paid: '0' },
        { userId: 'u2', roundId: 'r3', bets: 0, wagered: '0', rolledBackBets: 1, rolledBackStake: '5', wins: 0, paid: '0' },
        { ...base, userId: 'u2', roundId: 'r4', bets: 1, wagered: '7', wins: 1, paid: '0' },
    ]
    const palace = [
        { username: '9001', roundId: 'r1', gameCode: 'aviator', betAmount: 10, winAmount: 0 },
        { username: '9001', roundId: 'r1', gameCode: 'aviator', betAmount: 0, winAmount: 15 },
        { username: '9001', roundId: 'r2', gameCode: 'aviator', betAmount: 20, winAmount: 0 },
        { username: '9001', roundId: 'r2', gameCode: 'aviator', betAmount: 0, winAmount: 30 },
        { username: '9002', roundId: 'r3', gameCode: 'aviator', betAmount: 5, winAmount: 0 },
        { username: '9003', roundId: 'r9', gameCode: 'aviator', betAmount: 50, winAmount: 80 },
        { username: '9001', roundId: 'x1', gameCode: 'chicken-road', betAmount: 1, winAmount: 0 },
    ]

    it('reports mismatches, one-sided rounds and unmapped Palace players', () => {
        const res = diffAgainstPalace({
            ledger,
            palace,
            game: 'aviator',
            userByExternalCode: new Map([
                ['9001', 'u1'],
                ['9002', 'u2'],
            ]),
        })
        expect(res.palaceRowsForGame).toBe(6)
        expect(res.unmappedPalaceRows).toBe(1)
        expect(res.diffs).toEqual([
            { userId: null, externalUserCode: '9003', roundId: 'r9', kind: 'palace_only', ledgerWagered: 0, palaceWagered: 50, ledgerPaid: 0, palacePaid: 80 },
            { userId: 'u1', externalUserCode: '9001', roundId: 'r2', kind: 'amount_mismatch', ledgerWagered: 20, palaceWagered: 20, ledgerPaid: 0, palacePaid: 30 },
            { userId: 'u2', externalUserCode: null, roundId: 'r4', kind: 'ledger_only', ledgerWagered: 7, palaceWagered: 0, ledgerPaid: 0, palacePaid: 0 },
        ])
    })
})
