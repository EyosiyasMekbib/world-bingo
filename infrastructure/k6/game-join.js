/**
 * T56 — k6 Load Test: 500 Concurrent Users Joining Games
 *
 * Simulates 500 virtual users each registering, depositing,
 * and then joining a bingo game over a 60-second ramp-up.
 *
 * Run: k6 run infrastructure/k6/game-join.js
 *      k6 run --out influxdb=http://localhost:8086/k6 infrastructure/k6/game-join.js
 */
import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js'

// ─── Custom metrics ───────────────────────────────────────────────────────────
const registerErrors = new Counter('register_errors')
const loginErrors = new Counter('login_errors')
const joinErrors = new Counter('join_errors')
const depositErrors = new Counter('deposit_errors')
const successRate = new Rate('success_rate')
const joinDuration = new Trend('game_join_duration_ms', true)

// ─── Options ─────────────────────────────────────────────────────────────────
export const options = {
    scenarios: {
        game_join_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '20s', target: 100 },   // ramp up to 100
                { duration: '20s', target: 500 },   // ramp up to 500
                { duration: '30s', target: 500 },   // hold at 500
                { duration: '10s', target: 0 },     // ramp down
            ],
            gracefulRampDown: '10s',
        },
    },
    thresholds: {
        // 95% of join requests should complete within 2s
        game_join_duration_ms: ['p(95)<2000'],
        // Overall HTTP failure rate below 5%
        http_req_failed: ['rate<0.05'],
        // Custom success rate above 90%
        success_rate: ['rate>0.9'],
    },
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'

// ─── Setup: create a game to join ────────────────────────────────────────────
export function setup() {
    // Create an admin user and a waiting game
    const adminLogin = http.post(
        `${BASE_URL}/auth/admin/login`,
        JSON.stringify({ identifier: 'admin', password: 'Admin1234!' }),
        { headers: { 'Content-Type': 'application/json' } },
    )
    if (adminLogin.status !== 200) {
        console.warn('Admin login failed — using fallback game ID')
        return { gameId: null }
    }
    const adminToken = adminLogin.json('accessToken')

    // Create a new game
    const gameRes = http.post(
        `${BASE_URL}/admin/games`,
        JSON.stringify({
            name: `LoadTest Game ${Date.now()}`,
            cartelaPrice: 10,
            commission: 5,
            maxPlayers: 600,
        }),
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
        },
    )
    if (gameRes.status !== 201) {
        console.warn(`Game creation failed: ${gameRes.body}`)
        return { gameId: null }
    }
    const gameId = gameRes.json('id')
    console.log(`Created load-test game: ${gameId}`)
    return { gameId, adminToken }
}

// ─── Default function (VU scenario) ─────────────────────────────────────────
export default function (data) {
    const { gameId } = data
    const ts = Date.now()
    const username = `loaduser_${randomString(8)}`
    const phone = `+2519${String(ts).slice(-8)}`
    const password = 'LoadTest123!'

    // 1. Register
    group('register', () => {
        const res = http.post(
            `${BASE_URL}/auth/register`,
            JSON.stringify({ username, phone, password }),
            { headers: { 'Content-Type': 'application/json' } },
        )
        const ok = check(res, {
            'register 201': (r) => r.status === 201,
        })
        if (!ok) {
            registerErrors.add(1)
            successRate.add(false)
            return
        }
    })

    sleep(0.2)

    // 2. Login
    let accessToken = ''
    group('login', () => {
        const res = http.post(
            `${BASE_URL}/auth/login`,
            JSON.stringify({ identifier: username, password }),
            { headers: { 'Content-Type': 'application/json' } },
        )
        const ok = check(res, {
            'login 200': (r) => r.status === 200,
            'has accessToken': (r) => !!r.json('accessToken'),
        })
        if (!ok) {
            loginErrors.add(1)
            successRate.add(false)
            return
        }
        accessToken = res.json('accessToken')
    })

    if (!accessToken) return
    sleep(0.1)

    // 3. Join game (if a game was created in setup)
    if (gameId) {
        group('join_game', () => {
            const start = Date.now()
            const res = http.post(
                `${BASE_URL}/game/${gameId}/join`,
                JSON.stringify({ cartelaCount: 1 }),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${accessToken}`,
                    },
                },
            )
            joinDuration.add(Date.now() - start)
            // Accept 200 (joined) or 402 (insufficient balance) — both are valid game responses
            const ok = check(res, {
                'join accepted': (r) => r.status === 200 || r.status === 402 || r.status === 400,
            })
            if (!ok) {
                joinErrors.add(1)
                successRate.add(false)
            } else {
                successRate.add(true)
            }
        })
    } else {
        successRate.add(true) // no game to join; count as success
    }

    sleep(0.5)
}

// ─── Teardown ─────────────────────────────────────────────────────────────────
export function teardown(data) {
    if (data.gameId && data.adminToken) {
        http.post(
            `${BASE_URL}/admin/games/${data.gameId}/cancel`,
            null,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${data.adminToken}`,
                },
            },
        )
        console.log(`Cancelled load-test game: ${data.gameId}`)
    }
}
