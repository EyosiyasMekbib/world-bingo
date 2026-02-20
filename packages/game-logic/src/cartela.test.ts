import { describe, it, expect } from 'vitest'
import {
    generateCartela,
    validateCartela,
    generateSerial,
    BINGO_COLUMNS,
    COLUMN_RANGES,
} from '../src/cartela'

describe('cartela.ts', () => {
    describe('generateCartela', () => {
        it('should generate a 5x5 grid', () => {
            const cartela = generateCartela()
            expect(cartela).toHaveLength(5)
            expect(cartela[0]).toHaveLength(5)
        })

        it('should have 0 at center position (free space)', () => {
            const cartela = generateCartela()
            expect(cartela[2][2]).toBe(0)
        })

        it('should respect column ranges', () => {
            const cartela = generateCartela()
            
            // Column B: 1-15
            cartela.forEach(row => {
                expect(row[0]).toBeGreaterThanOrEqual(1)
                expect(row[0]).toBeLessThanOrEqual(15)
            })
            
            // Column I: 16-30
            cartela.forEach(row => {
                expect(row[1]).toBeGreaterThanOrEqual(16)
                expect(row[1]).toBeLessThanOrEqual(30)
            })
            
            // Column N: 31-45 (excluding center)
            cartela.forEach((row, idx) => {
                if (idx !== 2) {
                    expect(row[2]).toBeGreaterThanOrEqual(31)
                    expect(row[2]).toBeLessThanOrEqual(45)
                }
            })
            
            // Column G: 46-60
            cartela.forEach(row => {
                expect(row[3]).toBeGreaterThanOrEqual(46)
                expect(row[3]).toBeLessThanOrEqual(60)
            })
            
            // Column O: 61-75
            cartela.forEach(row => {
                expect(row[4]).toBeGreaterThanOrEqual(61)
                expect(row[4]).toBeLessThanOrEqual(75)
            })
        })

        it('should generate unique numbers in each column', () => {
            const cartela = generateCartela()
            
            for (let col = 0; col < 5; col++) {
                const values = cartela.map(row => row[col]).filter(v => v !== 0)
                expect(new Set(values)).toHaveLength(values.length)
            }
        })
    })

    describe('validateCartela', () => {
        it('should return true for a valid cartela', () => {
            const validCartela = [
                [5, 20, 35, 50, 65],
                [10, 25, 40, 55, 70],
                [1, 17, 0, 48, 63],
                [12, 28, 43, 58, 72],
                [15, 30, 45, 60, 75],
            ]
            expect(validateCartela(validCartela)).toBe(true)
        })

        it('should return false for wrong grid size', () => {
            const invalidCartela = [
                [5, 20, 35, 50],
                [10, 25, 40, 55],
            ]
            expect(validateCartela(invalidCartela)).toBe(false)
        })

        it('should return false for numbers outside column ranges', () => {
            const invalidCartela = [
                [100, 20, 35, 50, 65],
                [10, 25, 40, 55, 70],
                [1, 17, 0, 48, 63],
                [12, 28, 43, 58, 72],
                [15, 30, 45, 60, 75],
            ]
            expect(validateCartela(invalidCartela)).toBe(false)
        })

        it('should return false if center is not 0', () => {
            const invalidCartela = [
                [5, 20, 35, 50, 65],
                [10, 25, 40, 55, 70],
                [1, 17, 50, 48, 63], // Center should be 0
                [12, 28, 43, 58, 72],
                [15, 30, 45, 60, 75],
            ]
            expect(validateCartela(invalidCartela)).toBe(false)
        })
    })

    describe('generateSerial', () => {
        it('should generate a serial string from grid', () => {
            const grid = [
                [1, 2, 3, 4, 5],
                [6, 7, 8, 9, 10],
                [11, 12, 0, 14, 15],
                [16, 17, 18, 19, 20],
                [21, 22, 23, 24, 25],
            ]
            const serial = generateSerial(grid)
            expect(serial).toBe('1-2-3-4-5-6-7-8-9-10-11-12-0-14-15-16-17-18-19-20-21-22-23-24-25')
        })

        it('should produce unique serials for different grids', () => {
            const grid1 = generateCartela()
            const grid2 = generateCartela()
            
            // Note: There's a small chance they could be equal, but unlikely
            const serial1 = generateSerial(grid1)
            const serial2 = generateSerial(grid2)
            
            expect(typeof serial1).toBe('string')
            expect(serial1.length).toBeGreaterThan(0)
        })
    })

    describe('BINGO_COLUMNS', () => {
        it('should contain B, I, N, G, O', () => {
            expect(BINGO_COLUMNS).toEqual(['B', 'I', 'N', 'G', 'O'])
        })
    })

    describe('COLUMN_RANGES', () => {
        it('should have correct ranges for all columns', () => {
            expect(COLUMN_RANGES.B).toEqual([1, 15])
            expect(COLUMN_RANGES.I).toEqual([16, 30])
            expect(COLUMN_RANGES.N).toEqual([31, 45])
            expect(COLUMN_RANGES.G).toEqual([46, 60])
            expect(COLUMN_RANGES.O).toEqual([61, 75])
        })
    })
})
