/**
 * T52 — Prometheus metrics module
 * Registers default Node.js/process metrics and custom World Bingo metrics.
 */
import { Registry, collectDefaultMetrics, Counter, Gauge } from 'prom-client'

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
