# k6 Load Tests — World Bingo API

## Overview

Three k6 load test scripts for T56, covering the primary performance requirements:

| Script | Target | Threshold |
|---|---|---|
| `game-join.js` | 500 concurrent users joining games | p95 join < 2s |
| `websocket.js` | 1000 concurrent WebSocket connections | p95 connect < 3s |
| `wallet-throughput.js` | Rapid deposit/withdrawal flood | p95 deposit < 3s, p95 withdraw < 2s |

## Prerequisites

```bash
# macOS
brew install k6

# Ubuntu / Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker
docker pull grafana/k6
```

## Running the tests

> Make sure the API is running (`pnpm --filter @world-bingo/api dev` or Docker Compose) before running.

```bash
# Game-join load test (500 VUs)
k6 run infrastructure/k6/game-join.js

# Custom API URL
BASE_URL=http://api.staging.example.com k6 run infrastructure/k6/game-join.js

# WebSocket connection test (1000 VUs)
k6 run infrastructure/k6/websocket.js

# Wallet throughput (200 deposit VUs + 100 withdrawal VUs)
k6 run infrastructure/k6/wallet-throughput.js
```

## Running with Docker Compose (outputs to Grafana)

```bash
# Start the full stack (includes Prometheus + Grafana)
cd infrastructure
docker-compose up -d

# Run game-join test, stream results to InfluxDB (for Grafana k6 dashboard)
docker-compose run --rm k6 run --out influxdb=http://influxdb:8086/k6 /scripts/game-join.js
docker-compose run --rm k6 run --out influxdb=http://influxdb:8086/k6 /scripts/websocket.js
docker-compose run --rm k6 run --out influxdb=http://influxdb:8086/k6 /scripts/wallet-throughput.js
```

## Thresholds (CI failure conditions)

| Metric | Threshold |
|---|---|
| `game_join_duration_ms` p95 | < 2 000 ms |
| `ws_connect_duration_ms` p95 | < 3 000 ms |
| `deposit_duration_ms` p95 | < 3 000 ms |
| `withdraw_duration_ms` p95 | < 2 000 ms |
| `http_req_failed` | < 5% (10% for wallet) |
| `success_rate` | > 90% |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | API base URL |
| `ADMIN_USER` | `admin` | Admin username for setup |
| `ADMIN_PASSWORD` | `Admin1234!` | Admin password for setup |
