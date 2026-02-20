import { describe, it, expect } from 'vitest'
import {
    createMarkedGrid,
    checkAnyLine,
    checkDiagonals,
    checkFullCard,
    checkCorners,
    checkXPattern,
    checkPattern,
    type PatternName,
    type Grid,
} from '../src/patterns'

describe('patterns.ts', () => {
    const sampleGrid: Grid = [
        [1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10],
        [11, 12, 13, 14, 15],
        [16, 17, 18, 19, 20],
        [21, 22, 23, 24, 25],
    ]

    describe('createMarkedGrid', () => {
        it('should mark called balls on grid', () => {
            const calledBalls = new Set([1, 2, 3, 4, 5])
            const marked = createMarkedGrid(sampleGrid, calledBalls)
            
            // First row should be all marked
            expect(marked[0]).toEqual([true, true, true, true, true])
        })

        it('should always mark center as true (free space)', () => {
            const calledBalls = new Set<number>()
            const marked = createMarkedGrid(sampleGrid, calledBalls)
            
            expect(marked[2][2]).toBe(true)
        })

        it('should not mark uncalled balls', () => {
            const calledBalls = new Set([1])
            const marked = createMarkedGrid(sampleGrid, calledBalls)
            
            expect(marked[0][0]).toBe(true)
            expect(marked[0][1]).toBe(false)
        })
    })

    describe('checkAnyLine', () => {
        it('should return true for a horizontal line', () => {
            const marked = [
                [true, true, true, true, true],
                [false, false, false, false, false],
                [false, false, true, false, false], // center is free
                [false, false, false, false, false],
                [false, false, false, false, false],
            ]
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should return true for a vertical line', () => {
            const marked = [
                [true, false, false, false, false],
                [true, false, false, false, false],
                [true, false, true, false, false], // center is free
                [true, false, false, false, false],
                [true, false, false, false, false],
            ]
            expect(checkAnyLine(marked)).toBe(true)
        })

        it('should return false when no line is complete', () => {
            const marked = [
                [true, true, false, true, true],
                [false, false, false, false, false],
                [false, false, true, false, false],
                [false, false, false, false, false],
                [false, false, false, false, false],
            ]
            expect(checkAnyLine(marked)).toBe(false)
        })
    })

    describe('checkDiagonals', () => {
        it('should return true for main diagonal', () => {
            const marked = [
                [true, false, false, false, false],
                [false, true, false, false, false],
                [false, false, true, false, false],
                [false, false, false, true, false],
                [false, false, false, false, true],
            ]
            expect(checkDiagonals(marked)).toBe(true)
        })

        it('should return true for anti diagonal', () => {
            const marked = [
                [false, false, false, false, true],
                [false, false, false, true, false],
                [false, false, true, false, false],
                [false, true, false, false, false],
                [true, false, false, false, false],
            ]
            expect(checkDiagonals(marked)).toBe(true)
        })

        it('should return false when no diagonal is complete', () => {
            const marked = [
                [true, false, false, false, true],
                [false, true, false, false, false],
                [false, false, true, false, false],
                [false, false, false, false, false],
                [false, false, false, false, false],
            ]
            expect(checkDiagonals(marked)).toBe(false)
        })
    })

    describe('checkFullCard', () => {
        it('should return true when all cells are marked', () => {
            const marked = [
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, true],
            ]
            expect(checkFullCard(marked)).toBe(true)
        })

        it('should return false when any cell is unmarked', () => {
            const marked = [
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, true],
                [true, true, true, true, false],
            ]
            expect(checkFullCard(marked)).toBe(false)
        })
    })

    describe('checkCorners', () => {
        it('should return true when all four corners are marked', () => {
            const marked = [
                [true, false, false, false, true],
                [false, false, false, false, false],
                [false, false, true, false, false],
                [false, false, false, false, false],
                [true, false, false, false, true],
            ]
            expect(checkCorners(marked)).toBe(true)
        })

        it('should return false when any corner is unmarked', () => {
            const marked = [
                [true, false, false, false, false],
                [false, false, false, false, false],
                [false, false, true, false, false],
                [false, false, false, false, false],
                [true, false, false, false, true],
            ]
            expect(checkCorners(marked)).toBe(false)
        })
    })

    describe('checkXPattern', () => {
        it('should return true for X pattern (both diagonals)', () => {
            const marked = [
                [true, false, false, false, true],
                [false, true, false, true, false],
                [false, false, true, false, false],
                [false, true, false, true, false],
                [true, false, false, false, true],
            ]
            expect(checkXPattern(marked)).toBe(true)
        })
    })

    describe('checkPattern', () => {
        it('should check ANY_LINE pattern', () => {
            // Create a grid with first row numbers that will be called
            const gridWithFirstRow: Grid = [
                [1, 2, 3, 4, 5],
                [16, 17, 18, 19, 20],
                [31, 32, 0, 34, 35],
                [46, 47, 48, 49, 50],
                [61, 62, 63, 64, 65],
            ]
            // Call balls from the first row
            const calledBalls = new Set([1, 2, 3, 4, 5])
            expect(checkPattern('ANY_LINE', gridWithFirstRow, calledBalls)).toBe(true)
        })

        it('should check DIAGONAL pattern', () => {
            const calledBalls = new Set([1, 7, 13, 19, 25])
            expect(checkPattern('DIAGONAL', sampleGrid, calledBalls)).toBe(true)
        })

        it('should check FULL_CARD pattern', () => {
            const allBalls = new Set(sampleGrid.flat())
            expect(checkPattern('FULL_CARD', sampleGrid, allBalls)).toBe(true)
        })

        it('should check CORNERS pattern', () => {
            const calledBalls = new Set([1, 5, 21, 25])
            expect(checkPattern('CORNERS', sampleGrid, calledBalls)).toBe(true)
        })

        it('should return false for non-matching pattern', () => {
            const calledBalls = new Set([1])
            expect(checkPattern('FULL_CARD', sampleGrid, calledBalls)).toBe(false)
        })
    })
})
