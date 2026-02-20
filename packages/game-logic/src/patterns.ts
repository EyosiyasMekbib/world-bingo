export type Grid = number[][]
export type MarkedGrid = boolean[][]

export function createMarkedGrid(grid: Grid, calledBalls: Set<number>): MarkedGrid {
    return grid.map((row, r) =>
        row.map((cell, c) => {
            if (r === 2 && c === 2) return true
            return calledBalls.has(cell)
        }),
    )
}

export function checkAnyLine(marked: MarkedGrid): boolean {
    for (let i = 0; i < 5; i++) {
        if (marked[i].every(Boolean)) return true
        if (marked.every((row) => row[i])) return true
    }
    return false
}

export function checkDiagonals(marked: MarkedGrid): boolean {
    const mainDiag = [0, 1, 2, 3, 4].every((i) => marked[i][i])
    const antiDiag = [0, 1, 2, 3, 4].every((i) => marked[i][4 - i])
    return mainDiag || antiDiag
}

export function checkFullCard(marked: MarkedGrid): boolean {
    return marked.every((row) => row.every(Boolean))
}

export function checkCorners(marked: MarkedGrid): boolean {
    return marked[0][0] && marked[0][4] && marked[4][0] && marked[4][4]
}

export function checkXPattern(marked: MarkedGrid): boolean {
    return checkDiagonals(marked)
}

export type PatternName = 'ANY_LINE' | 'DIAGONAL' | 'FULL_CARD' | 'X_PATTERN' | 'CORNERS'

export function checkPattern(pattern: PatternName, grid: Grid, calledBalls: Set<number>): boolean {
    const marked = createMarkedGrid(grid, calledBalls)
    switch (pattern) {
        case 'ANY_LINE':
            return checkAnyLine(marked)
        case 'DIAGONAL':
            return checkDiagonals(marked)
        case 'FULL_CARD':
            return checkFullCard(marked)
        case 'X_PATTERN':
            return checkXPattern(marked)
        case 'CORNERS':
            return checkCorners(marked)
        default:
            return false
    }
}
