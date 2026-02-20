export const BINGO_COLUMNS = ['B', 'I', 'N', 'G', 'O'] as const
export const COLUMN_RANGES: Record<string, [number, number]> = {
    B: [1, 15],
    I: [16, 30],
    N: [31, 45],
    G: [46, 60],
    O: [61, 75],
}

export function generateCartela(): number[][] {
    const grid: number[][] = []
    for (let col = 0; col < 5; col++) {
        const [min, max] = Object.values(COLUMN_RANGES)[col]
        const pool = Array.from({ length: max - min + 1 }, (_, i) => i + min)
        const column: number[] = []
        for (let row = 0; row < 5; row++) {
            const idx = Math.floor(Math.random() * pool.length)
            column.push(pool.splice(idx, 1)[0])
        }
        grid.push(column)
    }
    const transposed = Array.from({ length: 5 }, (_, row) => grid.map((col) => col[row]))
    transposed[2][2] = 0
    return transposed
}

export function validateCartela(grid: number[][]): boolean {
    if (grid.length !== 5) return false
    for (let row = 0; row < 5; row++) {
        if (grid[row].length !== 5) return false
        for (let col = 0; col < 5; col++) {
            if (row === 2 && col === 2) {
                if (grid[row][col] !== 0) return false
                continue
            }
            const [min, max] = Object.values(COLUMN_RANGES)[col]
            if (grid[row][col] < min || grid[row][col] > max) return false
        }
    }
    return true
}

export function generateSerial(grid: number[][]): string {
    return grid.flat().join('-')
}
