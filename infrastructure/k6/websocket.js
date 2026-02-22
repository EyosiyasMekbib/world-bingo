/**
 * T56 — k6 Load Test: 1000 WebSocket Connections
 *
 * Simulates 1000 concurrent WebSocket clients connecting to the
 * Socket.IO server and subscribing to game events.
 *
 * Run: k6 run infrastructure/k6/websocket.js
 */
import { check, sleep } from 'k6'
import ws from 'k6/ws'
import { Counter, Rate, Trend } from 'k6/metrics'
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js'

// ─── Custom metrics ───────────────────────────────────────────────────────────
const wsConnectErrors = new Counter('ws_connect_errors')
const wsMessageErrors = new Counter('ws_message_errors')
const wsSuccessRate = new Rate('ws_success_rate')
const wsConnectDuration = new Trend('ws_connect_duration_ms', true)

// ─── Options ─────────────────────────────────────────────────────────────────
export const options = {
    scenarios: {
        websocket_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '20s', target: 200 },
                { duration: '20s', target: 1000 },
                { duration: '30s', target: 1000 },
                { duration: '10s', target: 0 },
            ],
            gracefulRampDown: '15s',
        },
    },
    thresholds: {
        ws_connect_duration_ms: ['p(95)<3000'],
        ws_success_rate: ['rate>0.85'],
        ws_connect_errors: ['count<50'],
    },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'
const WS_URL = BASE_URL.replace(/^http/, 'ws')

export default function () {
    // Register + login to get a token (Socket.IO requires auth)
    const username = `wsuser_${randomString(8)}`
    const phone = `+2519${String(Date.now()).slice(-8)}`

    const regRes = http.post(
        `${BASE_URL}/auth/register`,
        JSON.stringify({ username, phone, password: 'WsTest123!' }),
        { headers: { 'Content-Type': 'application/json' } },
    )

    if (regRes.status !== 201) {
        wsConnectErrors.add(1)
        wsSuccessRate.add(false)
        return
    }

    const token = regRes.json('accessToken')
    const start = Date.now()

    // Connect via Socket.IO polling (k6 uses raw WebSocket, emulate socket.io handshake)
    const socketUrl = `${WS_URL}/socket.io/?EIO=4&transport=websocket&token=${token}`

    const res = ws.connect(socketUrl, {}, function (socket) {
        wsConnectDuration.add(Date.now() - start)

        socket.on('open', () => {
            wsSuccessRate.add(true)

            // Send Socket.IO ping packet (type 2 = ping)
            socket.send('2')

            // Subscribe to lobby updates
            socket.send(`42["subscribe:lobby"]`)
        })

        socket.on('message', (msg) => {
            // Check we're getting proper socket.io frames (start with digit)
            const ok = check(msg, {
                'socket.io frame': (m) => /^[0-9]/.test(m),
            })
            if (!ok) wsMessageErrors.add(1)
        })

        socket.on('error', () => {
            wsConnectErrors.add(1)
            wsSuccessRate.add(false)
        })

        // Hold connection for 15 seconds (simulates a user watching the lobby)
        sleep(15)
        socket.close()
    })

    check(res, {
        'ws status 101': (r) => r && r.status === 101,
    })
}

// Need to import http for the registration step
import http from 'k6/http'
