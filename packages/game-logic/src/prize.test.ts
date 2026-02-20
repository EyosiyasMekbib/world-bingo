import { describe, it, expect } from 'vitest'
import {
    calculatePrizePool,
    calculateHouseCut,
    type PrizeConfig,
} from '../src/prize'

describe('prize.ts', () => {
    describe('calculatePrizePool', () => {
        it('should calculate prize pool with house edge', () => {
            const config: PrizeConfig = {
                entries: 10,
                ticketPrice: 10,
                houseEdgePct: 10,
            }
            // Gross: 10 * 10 = 100
            // House: 100 * 0.10 = 10
            // Prize pool: 100 - 10 = 90
            expect(calculatePrizePool(config)).toBe(90)
        })

        it('should handle different ticket prices', () => {
            const config: PrizeConfig = {
                entries: 5,
                ticketPrice: 20,
                houseEdgePct: 15,
            }
            // Gross: 5 * 20 = 100
            // House: 100 * 0.15 = 15
            // Prize pool: 100 - 15 = 85
            expect(calculatePrizePool(config)).toBe(85)
        })

        it('should handle 20% house edge', () => {
            const config: PrizeConfig = {
                entries: 100,
                ticketPrice: 50,
                houseEdgePct: 20,
            }
            // Gross: 100 * 50 = 5000
            // House: 5000 * 0.20 = 1000
            // Prize pool: 5000 - 1000 = 4000
            expect(calculatePrizePool(config)).toBe(4000)
        })

        it('should handle zero entries', () => {
            const config: PrizeConfig = {
                entries: 0,
                ticketPrice: 10,
                houseEdgePct: 10,
            }
            expect(calculatePrizePool(config)).toBe(0)
        })

        it('should floor the result to 2 decimal places', () => {
            const config: PrizeConfig = {
                entries: 1,
                ticketPrice: 10,
                houseEdgePct: 33, // 10 - 3.3 = 6.7
            }
            const result = calculatePrizePool(config)
            // Should floor to 6.69 (10 - 3.3 = 6.7, floored to 2 decimals)
            expect(result).toBe(6.69)
        })
    })

    describe('calculateHouseCut', () => {
        it('should calculate house cut correctly', () => {
            const config: PrizeConfig = {
                entries: 10,
                ticketPrice: 10,
                houseEdgePct: 10,
            }
            // Gross: 10 * 10 = 100
            // House: 100 * 0.10 = 10
            expect(calculateHouseCut(config)).toBe(10)
        })

        it('should handle 15% house edge', () => {
            const config: PrizeConfig = {
                entries: 20,
                ticketPrice: 50,
                houseEdgePct: 15,
            }
            // Gross: 20 * 50 = 1000
            // House: 1000 * 0.15 = 150
            expect(calculateHouseCut(config)).toBe(150)
        })

        it('should handle zero entries', () => {
            const config: PrizeConfig = {
                entries: 0,
                ticketPrice: 10,
                houseEdgePct: 10,
            }
            expect(calculateHouseCut(config)).toBe(0)
        })

        it('should floor the result', () => {
            const config: PrizeConfig = {
                entries: 1,
                ticketPrice: 10,
                houseEdgePct: 33, // 10 * 0.33 = 3.3, floored to 3.3
            }
            expect(calculateHouseCut(config)).toBe(3.3)
        })
    })

    describe('prize pool + house cut = gross', () => {
        it('should always equal gross ticket sales', () => {
            const configs: PrizeConfig[] = [
                { entries: 10, ticketPrice: 10, houseEdgePct: 10 },
                { entries: 5, ticketPrice: 20, houseEdgePct: 15 },
                { entries: 100, ticketPrice: 50, houseEdgePct: 20 },
                { entries: 1, ticketPrice: 100, houseEdgePct: 5 },
            ]

            for (const config of configs) {
                const gross = config.entries * config.ticketPrice
                const prizePool = calculatePrizePool(config)
                const houseCut = calculateHouseCut(config)
                
                expect(prizePool + houseCut).toBeCloseTo(gross, 2)
            }
        })
    })
})
