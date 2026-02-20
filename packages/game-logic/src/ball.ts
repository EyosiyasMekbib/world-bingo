const TOTAL_BALLS = 75

export function createBallPool(): number[] {
    return Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)
}

export function drawBall(remaining: number[]): { ball: number; remaining: number[] } {
    if (remaining.length === 0) throw new Error('No balls remaining in the pool')
    const idx = Math.floor(Math.random() * remaining.length)
    const ball = remaining[idx]
    const next = [...remaining.slice(0, idx), ...remaining.slice(idx + 1)]
    return { ball, remaining: next }
}

export function getBallColumn(ball: number): string {
    if (ball >= 1 && ball <= 15) return 'B'
    if (ball >= 16 && ball <= 30) return 'I'
    if (ball >= 31 && ball <= 45) return 'N'
    if (ball >= 46 && ball <= 60) return 'G'
    return 'O'
}
