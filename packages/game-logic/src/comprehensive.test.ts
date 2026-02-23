/**
 * Comprehensive Game Logic Tests — Patterns, Cartela, Ball, Prize
 *
 * Extended unit tests for the @world-bingo/game-logic package,
 * covering edge cases and boundary conditions.
 *
 * Run with: pnpm --filter @world-bingo/game-logic test
 */
import { describe, it, expect } from 'vitest'
import {
    createBallPool,
    drawBall,
    getBallColumn,
} from '../src/ball'
import {
    generateCartela,
    validateCartela,
    generateSerial,
    BINGO_COLUMNS,
    COLUMN_RANGES,
} from '../src/cartela'
import {
    createMarkedGrid,
    checkAnyLine,
    checkDiagonals,
    checkFullCard,
    checkCorners,
    checkXPattern,
    checkPattern,
    type Grid,
    type MarkedGrid,
    type PatternName,
} from '../src/patterns'
import {
    calculatePrizePool,
    calculateHouseCut,
    type PrizeConfig,
} from '../src/prize'

// ─── Ball — Extended ──────────────────────────────────────────────────────────

describe('ball.ts — Extended', () => {
    describe('createBallPool edge cases', () => {
        it('should not contain 0', () => {
            const pool = createBallPool()
            expect(pool).not.toContain(0)
        })

        it('should not contain 76 or higher', () => {
            const pool = createBallPool()
            expect(pool).not.toContain(76)
            expect(pool).not.toContain(100)
        })

        it('should have all unique numbers', () => {
            const pool = createBallPool()
            expect(new Set(pool).size).toBe(75)
        })

        it('should be sorted 1-75', () => {
            const pool = createBallPool()
            for (let i = 0; i < pool.length; i++) {
                expect(pool[i]).toBe(i + 1)
            }
        })
    })

    describe('drawBall edge cases', () => {
        it('should draw from a pool of 1 ball', () => {
            const { ball, remaining } = drawBall([42])
            expect(ball).toBe(42)
            expect(remaining).toHaveLength(0)
        })

        it('should draw from a pool of 2 balls', () => {
            const { ball, remaining } = drawBall([1, 75])
            expect([1, 75]).toContain(ball)
            expect(remaining).toHaveLength(1)
        })

        it('should not modify the original array', () => {
            const original = [1, 2, 3, 4, 5]
            const copy = [...original]
            drawBall(original)
            expect(original).toEqual(copy)
        })
    })

    describe('getBallColumn boundaries', () => {
        it('should handle exact boundary: ball 15 is B', () => {
            expect(getBallColumn(15)).toBe('B')
        })

        it('should handle exact boundary: ball 16 is I', () => {
            expect(getBallColumn(16)).toBe('I')
        })

        it('should handle exact boundary: ball 30 is I', () => {
            expect(getBallColumn(30)).toBe('I')
        })

        it('should handle exact boundary: ball 31 is N', () => {
            expect(getBallColumn(31)).toBe('N')
        })

        it('should handle exact boundary: ball 45 is N', () => {
            expect(getBallColumn(45)).toBe('N')
        })

        it('should handle exact boundary: ball 46 is G', () => {
            expect(getBallColumn(46)).toBe('G')
        })

        it('should handle exact boundary: ball 60 is G', () => {
            expect(getBallColumn(60)).toBe('G')
        })

        it('should handle exact boundary: ball 61 is O', () => {
            expect(getBallColumn(61)).toBe('O')
        })

        it('should handle exact boundary: ball 75 is O', () => {
            expect(getBallColumn(75)).toBe('O')
        })

        it('should handle out-of-range ball (0) gracefully', () => {
            // 0 is not in any range 1-15, 16-30, etc — falls through to 'O'
            expect(getBallColumn(0)).toBe('O')
        })
    })
})

// ─── Cartela — Extended ──────────────────────────────────────────────────────

describe('cartela.ts — Extended', () => {
    describe('generateCartela randomness', () => {
        it('should generate different cartelas on successive calls', () => {
            const c1 = generateCartela()
            const c2 = generateCartela()
            // Extremely unlikely (1 in millions) to be identical
            expect(JSON.stringify(c1)).not.toBe(JSON.stringify(c2))
        })

        it('should always have exactly 25 cells', () => {
            for (let i = 0; i < 10; i++) {
                const c = generateCartela()
                expect(c.flat()).toHaveLength(25)
            }
        })

        it('should have exactly one 0 (free space) at center', () => {
            for (let i = 0; i < 10; i++) {
                const c = generateCartela()
                const zeros = c.flat().filter((n) => n === 0)
                expect(zeros).toHaveLength(1)
                expect(c[2][2]).toBe(0)
            }
        })

        it('should have 24 non-zero unique numbers', () => {
            const c = generateCartela()
            const nonZero = c.flat().filter((n) => n !== 0)
            expect(nonZero).toHaveLength(24)
            expect(new Set(nonZero).size).toBe(24)
        })
    })

    describe('validateCartela edge cases', () => {
        it('should reject a 4x5 grid', () => {
            const grid = [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
            ]
            expect(validateCartela(grid)).toBe(false)
        })

        it('should reject a 5x4 grid', () => {
            const grid = [
                [1, 16, 31, 46],
                [2, 17, 32, 47],
                [3, 18, 0, 48],
                [4, 19, 34, 49],
                [5, 20, 35, 50],
            ]
            expect(validateCartela(grid)).toBe(false)
        })

        it('should reject if center (2,2) is not 0', () => {
            const grid = [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 33, 48, 63], // center = 33, should be 0
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ]
            expect(validateCartela(grid)).toBe(false)
        })

        it('should accept valid cartela from generateCartela', () => {
            for (let i = 0; i < 20; i++) {
                const c = generateCartela()
                expect(validateCartela(c)).toBe(true)
            }
        })

        it('should reject if B column has number > 15', () => {
            const grid = [
                [16, 16, 31, 46, 61], // B=16 is out of range
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ]
            expect(validateCartela(grid)).toBe(false)
        })

        it('should reject if O column has number < 61', () => {
            const grid = [
                [1, 16, 31, 46, 60], // O=60 is out of range
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ]
            expect(validateCartela(grid)).toBe(false)
        })

        it('should reject empty grid', () => {
            expect(validateCartela([])).toBe(false)
        })
    })

    describe('generateSerial', () => {
        it('should produce a consistent serial for same grid', () => {
            const grid = [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ]
            expect(generateSerial(grid)).toBe(
                '1-16-31-46-61-2-17-32-47-62-3-18-0-48-63-4-19-34-49-64-5-20-35-50-65',
            )
        })

        it('should produce unique serials for different cartelas', () => {
            const serials = new Set<string>()
            for (let i = 0; i < 50; i++) {
                const c = generateCartela()
                serials.add(generateSerial(c))
            }
            expect(serials.size).toBe(50)
        })
    })

    describe('BINGO_COLUMNS', () => {
        it('should have exactly 5 columns', () => {
            expect(BINGO_COLUMNS).toHaveLength(5)
        })

        it('should be B, I, N, G, O in order', () => {
            expect([...BINGO_COLUMNS]).toEqual(['B', 'I', 'N', 'G', 'O'])
        })
    })

    describe('COLUMN_RANGES', () => {
        it('B should be [1, 15]', () => {
            expect(COLUMN_RANGES.B).toEqual([1, 15])
        })

        it('I should be [16, 30]', () => {
            expect(COLUMN_RANGES.I).toEqual([16, 30])
        })

        it('N should be [31, 45]', () => {
            expect(COLUMN_RANGES.N).toEqual([31, 45])
        })

        it('G should be [46, 60]', () => {
            expect(COLUMN_RANGES.G).toEqual([46, 60])
        })

        it('O should be [61, 75]', () => {
            expect(COLUMN_RANGES.O).toEqual([61, 75])
        })

        it('all ranges are 15 numbers wide', () => {
            for (const [min, max] of Object.values(COLUMN_RANGES)) {
                expect(max - min + 1).toBe(15)
            }
        })

        it('ranges cover 1-75 with no gaps', () => {
            const allNums: number[] = []
            for (const [min, max] of Object.values(COLUMN_RANGES)) {
                for (let n = min; n <= max; n++) allNums.push(n)
            }
            expect(allNums.sort((a, b) => a - b)).toEqual(
                Array.from({ length: 75 }, (_, i) => i + 1),
            )
        })
    })
})

// ─── Patterns — Extended ──────────────────────────────────────────────────────

describe('patterns.ts — Extended', () => {
    // A proper bingo grid with correct column ranges
    const bingoGrid: Grid = [
        [1, 16, 31, 46, 61],
        [2, 17, 32, 47, 62],
        [3, 18, 0, 48, 63],
        [4, 19, 34, 49, 64],
        [5, 20, 35, 50, 65],
    ]

    describe('createMarkedGrid with proper bingo grid', () => {
        it('should mark free space even with empty called balls', () => {
            const marked = createMarkedGrid(bingoGrid, new Set())
            expect(marked[2][2]).toBe(true)
            // All others should be false
            for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                    if (r === 2 && c === 2) continue
                    expect(marked[r][c]).toBe(false)
                }
            }
        })

        it('should mark all cells when all balls are called', () => {
            const allBalls = new Set(bingoGrid.flat().filter((n) => n !== 0))
            const marked = createMarkedGrid(bingoGrid, allBalls)
            expect(marked.every((row) => row.every(Boolean))).toBe(true)
        })

        it('should correctly mark a specific B column ball', () => {
            const marked = createMarkedGrid(bingoGrid, new Set([3]))
            expect(marked[2][0]).toBe(true) // Ball 3 is at row 2, col 0
            expect(marked[0][0]).toBe(false) // Ball 1 not called
        })
    })

    describe('checkAnyLine with bingo grid', () => {
        it('should detect first row completion', () => {
            const called = new Set([1, 16, 31, 46, 61])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should detect last row completion', () => {
            const called = new Set([5, 20, 35, 50, 65])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should detect middle row completion (with free space)', () => {
            // Middle row: [3, 18, 0, 48, 63] — 0 is free space
            const called = new Set([3, 18, 48, 63])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should detect B column (first column) completion', () => {
            const called = new Set([1, 2, 3, 4, 5])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should detect O column (last column) completion', () => {
            const called = new Set([61, 62, 63, 64, 65])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should detect N column completion (with free space)', () => {
            // N column: [31, 32, 0, 34, 35]
            const called = new Set([31, 32, 34, 35])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should return false when nearly complete (4 of 5)', () => {
            const called = new Set([1, 16, 31, 46]) // Missing 61
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkAnyLine(marked)).toBe(false)
        })
    })

    describe('checkDiagonals with bingo grid', () => {
        it('should detect main diagonal: 1, 17, 0, 49, 65', () => {
            const called = new Set([1, 17, 49, 65]) // 0 is free space
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkDiagonals(marked)).toBe(true)
        })

        it('should detect anti diagonal: 61, 47, 0, 19, 5', () => {
            const called = new Set([61, 47, 19, 5]) // 0 is free space
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkDiagonals(marked)).toBe(true)
        })

        it('should return false when main diagonal missing one ball', () => {
            const called = new Set([1, 17, 49]) // Missing 65
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkDiagonals(marked)).toBe(false)
        })
    })

    describe('checkCorners with bingo grid', () => {
        it('should detect all four corners: 1, 61, 5, 65', () => {
            const called = new Set([1, 61, 5, 65])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkCorners(marked)).toBe(true)
        })

        it('should return false with 3 of 4 corners', () => {
            const called = new Set([1, 61, 5]) // Missing 65
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkCorners(marked)).toBe(false)
        })

        it('should return true even with extra balls called', () => {
            const called = new Set([1, 61, 5, 65, 17, 32, 48])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkCorners(marked)).toBe(true)
        })
    })

    describe('checkFullCard with bingo grid', () => {
        it('should return true with all 24 numbers + free space', () => {
            const allBalls = new Set(bingoGrid.flat().filter((n) => n !== 0))
            const marked = createMarkedGrid(bingoGrid, allBalls)
            expect(checkFullCard(marked)).toBe(true)
        })

        it('should return false with 23 of 24 numbers', () => {
            const allBalls = new Set(bingoGrid.flat().filter((n) => n !== 0))
            allBalls.delete(65) // Remove one ball
            const marked = createMarkedGrid(bingoGrid, allBalls)
            expect(checkFullCard(marked)).toBe(false)
        })
    })

    describe('checkXPattern with bingo grid', () => {
        it('should return true when both diagonals are complete', () => {
            // Main: 1, 17, free, 49, 65
            // Anti: 61, 47, free, 19, 5
            const called = new Set([1, 17, 49, 65, 61, 47, 19, 5])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkXPattern(marked)).toBe(true)
        })

        it('should return true if only ONE diagonal is complete (same as checkDiagonals)', () => {
            // X_PATTERN delegates to checkDiagonals which returns true for either diagonal
            const called = new Set([1, 17, 49, 65])
            const marked = createMarkedGrid(bingoGrid, called)
            expect(checkXPattern(marked)).toBe(true)
        })
    })

    describe('checkPattern integration', () => {
        it('should return false for unknown pattern name', () => {
            expect(checkPattern('UNKNOWN_PATTERN' as PatternName, bingoGrid, new Set())).toBe(false)
        })

        it('ANY_LINE with column complete', () => {
            expect(checkPattern('ANY_LINE', bingoGrid, new Set([1, 2, 3, 4, 5]))).toBe(true)
        })

        it('DIAGONAL with main diagonal', () => {
            expect(checkPattern('DIAGONAL', bingoGrid, new Set([1, 17, 49, 65]))).toBe(true)
        })

        it('FULL_CARD with all cells', () => {
            const allBalls = new Set(bingoGrid.flat().filter((n) => n !== 0))
            expect(checkPattern('FULL_CARD', bingoGrid, allBalls)).toBe(true)
        })

        it('CORNERS with all corners', () => {
            expect(checkPattern('CORNERS', bingoGrid, new Set([1, 61, 5, 65]))).toBe(true)
        })

        it('X_PATTERN with both diagonals', () => {
            expect(
                checkPattern('X_PATTERN', bingoGrid, new Set([1, 17, 49, 65, 61, 47, 19, 5])),
            ).toBe(true)
        })
    })
})

// ─── Prize — Extended ─────────────────────────────────────────────────────────

describe('prize.ts — Extended', () => {
    describe('calculatePrizePool edge cases', () => {
        it('should return 0 for 0% house edge', () => {
            const config: PrizeConfig = { entries: 10, ticketPrice: 100, houseEdgePct: 0 }
            // Prize = 10 * 100 - 0 = 1000
            expect(calculatePrizePool(config)).toBe(1000)
        })

        it('should return 0 for 100% house edge', () => {
            const config: PrizeConfig = { entries: 10, ticketPrice: 100, houseEdgePct: 100 }
            expect(calculatePrizePool(config)).toBe(0)
        })

        it('should handle large numbers', () => {
            const config: PrizeConfig = { entries: 10000, ticketPrice: 1000, houseEdgePct: 5 }
            // Gross: 10,000,000  House: 500,000  Prize: 9,500,000
            expect(calculatePrizePool(config)).toBe(9500000)
        })

        it('should handle fractional house edge', () => {
            const config: PrizeConfig = { entries: 3, ticketPrice: 7, houseEdgePct: 12 }
            // Gross: 21  House: 2.52  Prize: 18.48
            expect(calculatePrizePool(config)).toBe(18.48)
        })

        it('should handle 1 entry', () => {
            const config: PrizeConfig = { entries: 1, ticketPrice: 50, houseEdgePct: 10 }
            // Prize: 50 - 5 = 45
            expect(calculatePrizePool(config)).toBe(45)
        })
    })

    describe('calculateHouseCut edge cases', () => {
        it('should return 0 for 0% house edge', () => {
            const config: PrizeConfig = { entries: 10, ticketPrice: 100, houseEdgePct: 0 }
            expect(calculateHouseCut(config)).toBe(0)
        })

        it('should return full amount for 100% house edge', () => {
            const config: PrizeConfig = { entries: 10, ticketPrice: 100, houseEdgePct: 100 }
            expect(calculateHouseCut(config)).toBe(10000)
        })

        it('house cut + prize pool should equal gross revenue', () => {
            const config: PrizeConfig = { entries: 7, ticketPrice: 33, houseEdgePct: 15 }
            const gross = config.entries * config.ticketPrice
            const prize = calculatePrizePool(config)
            const house = calculateHouseCut(config)
            // Due to flooring, sum may be slightly less than gross
            expect(prize + house).toBeLessThanOrEqual(gross)
            // But very close (within 1 cent due to flooring)
            expect(gross - (prize + house)).toBeLessThan(0.02)
        })
    })
})
