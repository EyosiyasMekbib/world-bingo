import { describe, it, expect, beforeEach } from 'vitest'
import {
    createBallPool,
    drawBall,
    getBallColumn,
} from '../src/ball'

describe('ball.ts', () => {
    describe('createBallPool', () => {
        it('should create a pool of 75 balls', () => {
            const pool = createBallPool()
            expect(pool).toHaveLength(75)
        })

        it('should contain numbers from 1 to 75', () => {
            const pool = createBallPool()
            expect(pool).toContain(1)
            expect(pool).toContain(75)
            expect(pool).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]))
        })
    })

    describe('drawBall', () => {
        it('should draw a ball and return remaining pool', () => {
            const pool = createBallPool()
            const { ball, remaining } = drawBall(pool)
            
            expect(pool).toContain(ball)
            expect(remaining).toHaveLength(74)
            expect(remaining).not.toContain(ball)
        })

        it('should throw when pool is empty', () => {
            expect(() => drawBall([])).toThrow('No balls remaining in the pool')
        })

        it('should eventually draw all balls', () => {
            let pool = createBallPool()
            const drawn: number[] = []
            
            while (pool.length > 0) {
                const result = drawBall(pool)
                drawn.push(result.ball)
                pool = result.remaining
            }
            
            expect(drawn).toHaveLength(75)
            expect(new Set(drawn)).toHaveLength(75) // All unique
        })
    })

    describe('getBallColumn', () => {
        it('should return B for balls 1-15', () => {
            expect(getBallColumn(1)).toBe('B')
            expect(getBallColumn(15)).toBe('B')
        })

        it('should return I for balls 16-30', () => {
            expect(getBallColumn(16)).toBe('I')
            expect(getBallColumn(30)).toBe('I')
        })

        it('should return N for balls 31-45', () => {
            expect(getBallColumn(31)).toBe('N')
            expect(getBallColumn(45)).toBe('N')
        })

        it('should return G for balls 46-60', () => {
            expect(getBallColumn(46)).toBe('G')
            expect(getBallColumn(60)).toBe('G')
        })

        it('should return O for balls 61-75', () => {
            expect(getBallColumn(61)).toBe('O')
            expect(getBallColumn(75)).toBe('O')
        })
    })
})
