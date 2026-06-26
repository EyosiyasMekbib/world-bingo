/**
 * T52 — Prometheus metrics module
 * Registers default Node.js/process metrics and custom World Bingo metrics.
 */
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client'

export const register = new Registry()

// Collect default Node.js metrics (event loop lag, heap, GC, etc.)
collectDefaultMetrics({ register })

// ── Custom Metrics ─────────────────────────────────────────────────────────

/** Total HTTP requests, labelled by method, route, and status code */
export const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [register],
})

/** Active WebSocket connections */
export const wsConnectionsActive = new Gauge({
    name: 'ws_connections_active',
    help: 'Number of currently active WebSocket connections',
    registers: [register],
})

/** Games currently in WAITING or IN_PROGRESS state */
export const gamesActive = new Gauge({
    name: 'games_active',
    help: 'Number of active games (WAITING + IN_PROGRESS)',
    registers: [register],
})

/** Total wallet transactions processed, labelled by type and status */
export const walletTransactionsTotal = new Counter({
    name: 'wallet_transactions_total',
    help: 'Total wallet transactions processed',
    labelNames: ['type', 'status'] as const,
    registers: [register],
})

// ── World Bingo Domain Metrics (wb_*) ──────────────────────────────────────

/** Wall-clock duration of a game from start to completion, by outcome */
export const wbGameDurationSeconds = new Histogram({
    name: 'wb_game_duration_seconds',
    help: 'Wall-clock duration of a game from start to completion',
    labelNames: ['outcome'] as const,
    buckets: [10, 30, 60, 120, 180, 300, 600, 900, 1800],
    registers: [register],
})

/** Total games completed, labelled by outcome (winner | no_winner) */
export const wbGamesCompletedTotal = new Counter({
    name: 'wb_games_completed_total',
    help: 'Total games completed, by outcome',
    labelNames: ['outcome'] as const,
    registers: [register],
})

/** Latency of claimBingo payout transaction */
export const wbPayoutLatencySeconds = new Histogram({
    name: 'wb_game_payout_latency_seconds',
    help: 'Latency of claimBingo payout transaction',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
})

/** Total payouts, labelled by status (success | fail) */
export const wbPayoutsTotal = new Counter({
    name: 'wb_game_payouts_total',
    help: 'Total game payouts, by status',
    labelNames: ['status'] as const,
    registers: [register],
})

/** Total deposits, labelled by method and status */
export const wbDepositsTotal = new Counter({
    name: 'wb_deposits_total',
    help: 'Total deposits, by method and status',
    labelNames: ['method', 'status'] as const,
    registers: [register],
})

/** Total withdrawals, labelled by status */
export const wbWithdrawalsTotal = new Counter({
    name: 'wb_withdrawals_total',
    help: 'Total withdrawals, by status',
    labelNames: ['status'] as const,
    registers: [register],
})

/** Total refunds, labelled by reason (under_fill | cancel | other) */
export const wbRefundsTotal = new Counter({
    name: 'wb_refunds_total',
    help: 'Total refunds, by reason',
    labelNames: ['reason'] as const,
    registers: [register],
})

/** Cartela reservations / game joins */
export const wbGameEntriesTotal = new Counter({
    name: 'wb_game_entries_total',
    help: 'Cartela reservations / game joins',
    registers: [register],
})

/** BullMQ job counts by queue and state */
export const wbBullmqJobs = new Gauge({
    name: 'wb_bullmq_jobs',
    help: 'BullMQ job counts by queue and state',
    labelNames: ['queue', 'state'] as const,
    registers: [register],
})
