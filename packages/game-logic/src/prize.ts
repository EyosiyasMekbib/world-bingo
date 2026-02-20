export interface PrizeConfig {
    entries: number
    ticketPrice: number
    houseEdgePct: number
}

export function calculatePrizePool({ entries, ticketPrice, houseEdgePct }: PrizeConfig): number {
    const gross = entries * ticketPrice
    const house = gross * (houseEdgePct / 100)
    return Math.floor((gross - house) * 100) / 100
}

export function calculateHouseCut({ entries, ticketPrice, houseEdgePct }: PrizeConfig): number {
    const gross = entries * ticketPrice
    return Math.floor(gross * (houseEdgePct / 100) * 100) / 100
}
