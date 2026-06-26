# World Bingo — Observability Runbook

> **Scope:** Error tracking, logs, traces, metrics, alerting, and uptime for all brands.
> **Golden rule:** every integration is **env-gated and a no-op when unset**. With nothing
> configured the apps boot and run exactly as before — wire things in one signal at a time.

---

## Architecture at a glance

A single **central shared stack** runs from `docker-compose.observability.yml` on the external
`dokploy-network`. Every brand PUSHES errors, logs, and traces into it. Pull-based metric
exporters (Prometheus) live **per-brand** because each brand has its own Prometheus + Grafana.

| Tool | Service | What it does | How signals arrive |
|---|---|---|---|
| **GlitchTip** | `wb-glitchtip` | Error tracking (Sentry-compatible) | Apps push via the Sentry SDK / DSN |
| **Loki** | `wb-loki` | Log aggregation | API ships pino logs (push) |
| **Tempo** | `wb-tempo` | Distributed traces | OpenTelemetry OTLP (push, ports 4317/4318) |
| **Alertmanager** | `wb-alertmanager` | Alert routing | Each brand's Prometheus pushes alerts |
| **Uptime Kuma** | `wb-uptime-kuma` | External uptime monitoring | Polls public endpoints |
| **Prometheus** | `prometheus-<brand>` | Metric scrape + alert rules | Pulls `/metrics` + exporters (per-brand) |
| **Grafana** | `grafana-<brand>` | Dashboards | Queries Prometheus / Loki / Tempo (per-brand) |

### Naming rules (important)

- **All central service names are prefixed `wb-`** (`wb-loki`, `wb-tempo`, `wb-glitchtip`,
  `wb-alertmanager`, `wb-uptime-kuma`). They share `dokploy-network` with unrelated Dokploy
  stacks, so the prefix prevents collisions — a bare alias such as `api` once cross-served
  another stack. Clients reach them at e.g. `http://wb-loki:3100`, `http://wb-tempo:4318`.
- **Per-brand exporters are suffixed** `-arada` / `-betbawa` (e.g. `node-exporter-arada`,
  `postgres-exporter-betbawa`), matching the existing `api-arada` / `prometheus-betbawa`
  convention. In the local `docker-compose.yml` and `infrastructure/docker-compose*.yml`
  they are **unsuffixed** (`node-exporter`, `cadvisor`, `postgres-exporter`, `redis-exporter`).

---

## 1. Bring up the central stack

The central stack is deployed once (its own Dokploy Compose service) and shared by all brands.

```bash
# From the repo root, with the central observability env vars filled in (.env):
docker compose -f docker-compose.observability.yml up -d
```

This starts GlitchTip (web + worker + one-shot migrate, with its own Postgres + Redis), Loki,
Tempo, Alertmanager, and Uptime Kuma. Config files live under `infrastructure/`:

- `infrastructure/loki/loki-config.yml`
- `infrastructure/tempo/tempo-config.yml`
- `infrastructure/alertmanager/alertmanager.yml`

Verify the services are healthy, then expose the two UIs so you can finish setup. These services
publish **no host port** (same pattern as the brand apps — the Dokploy proxy fronts them over
`dokploy-network`), so attach a Dokploy domain / Traefik route to each:

- `wb-glitchtip` → container port **8080** (GlitchTip UI, needed to mint DSNs in step 2)
- `wb-uptime-kuma` → container port **3001** (Uptime Kuma dashboard)

Loki, Tempo, and Alertmanager need no public domain — brand Prometheus/Grafana reach them
internally over `dokploy-network`.

---

## 2. Create a GlitchTip project and get a DSN

1. Open the GlitchTip UI (`GLITCHTIP_DOMAIN`) and create / sign in to the admin account.
2. Create an **Organization** (once), then a **Project** per app you want to track
   (e.g. `world-bingo-api`, `world-bingo-web`, `world-bingo-admin`).
3. Open the project → **Settings → Client Keys (DSN)** and copy the DSN. It looks like:
   `https://<public-key>@glitchtip.example.com/<project-id>`.
4. Paste the DSN into the matching env var:
   - API → `SENTRY_DSN`
   - Web → `NUXT_PUBLIC_SENTRY_DSN` (owned by the web/admin agents' `.env.example`)
   - Admin → `NUXT_PUBLIC_SENTRY_DSN`

Leaving a DSN empty keeps that app's error reporting completely inert.

---

## 3. Set per-brand env in Dokploy

For each brand's Compose service in Dokploy, paste the observability env vars into the
**Environment Variables** panel. Use the root `.env.example` as the canonical list; the
api-consumed subset is mirrored in `apps/api/.env.example`.

| Variable | Set to | Effect when empty / false |
|---|---|---|
| `SENTRY_DSN` | brand's GlitchTip DSN | Sentry reporting is a no-op |
| `SENTRY_ENVIRONMENT` | `production` / `staging` | — |
| `SENTRY_RELEASE` | git sha / version (optional) | release unset |
| `NUXT_PUBLIC_SENTRY_DSN` | web/admin GlitchTip DSN | client Sentry is a no-op |
| `NUXT_PUBLIC_SENTRY_ENVIRONMENT` | `production` / `staging` | — |
| `OTEL_ENABLED` | `true` to enable tracing | no auto-instrumentation loaded |
| `LOKI_URL` | `http://wb-loki:3100` | logs stay on stdout only |
| `POSTGRES_EXPORTER_DSN` | DB DSN (`?sslmode=disable`) | postgres-exporter has nothing to scrape |
| `GRAFANA_PASSWORD` | strong password | (already required pre-observability) |

Brand-qualify the service-name labels where useful, e.g. `OTEL_SERVICE_NAME=world-bingo-api-arada`
and `LOKI_LABEL_APP=world-bingo-api-arada`, so signals are distinguishable across brands.

Remember the central services are only reachable on `dokploy-network`. The compose files attach
each brand's `prometheus-<brand>` and `grafana-<brand>` to `dokploy-network` (in addition to the
private `internal` network) so they can reach `wb-alertmanager`, `wb-loki`, and `wb-tempo`.

---

## 4. Enable OpenTelemetry traces

Tracing is off by default. To enable it for a brand's API:

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://wb-tempo:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=world-bingo-api-<brand>
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

The API entrypoint only loads `@opentelemetry/auto-instrumentations-node` when
`OTEL_ENABLED=true`; otherwise it runs `node dist/index.js` unchanged. The auto-instrumentation
reads the `OTEL_*` vars — no custom OTel code is required. Redeploy the brand after changing these.
View traces in Grafana via the **Tempo** datasource.

---

## 5. Enable Loki log shipping

Log shipping is off by default. Set:

```env
LOKI_URL=http://wb-loki:3100
LOKI_LABEL_APP=world-bingo-api-<brand>
```

When `LOKI_URL` is empty the logger behaves exactly as today (stdout only). When set, pino ships
to Loki with labels `{ app: LOKI_LABEL_APP, env: NODE_ENV }` while keeping the existing redaction.
Query logs in Grafana via the **Loki** datasource.

---

## 6. Metrics, dashboards, and alert rules

- The API exposes Prometheus metrics at `/metrics` (the existing core metrics plus the new
  `wb_*` business metrics). Per-brand exporters cover host (`node-exporter`), containers
  (`cadvisor`), Postgres (`postgres-exporter`), and Redis (`redis-exporter`).
- Grafana ships two dashboards: **`wb-domain`** (business metrics — payout latency, payouts
  success/fail, deposits, refunds, game duration, BullMQ queue depth) and **`wb-infra`**
  (host/container/Postgres/Redis health).
- **Alert rules live in `infrastructure/prometheus/alert-rules.yml`** (shared by all brands; each
  Prometheus mounts it at `/etc/prometheus/alert-rules.yml` and references it via `rule_files`).
  Each brand's Prometheus forwards firing alerts to `wb-alertmanager:9093`.

---

## 7. Alertmanager notification wiring (intentional TODO)

`infrastructure/alertmanager/alertmanager.yml` is structurally complete and valid, but **does not
route to any real notification channel yet**. It uses a default `null` receiver and includes a
clearly-commented placeholder block showing where a future receiver would go.

This is **intentional** — notification wiring is left as a TODO. There is deliberately **no
Telegram** (or any other notifier) configured. When a channel is chosen, add the receiver in
`alertmanager.yml` and point the route at it, then redeploy the central stack.

---

## Quick reference: where things live

| Concern | Location |
|---|---|
| Central stack compose | `docker-compose.observability.yml` |
| Loki config | `infrastructure/loki/loki-config.yml` |
| Tempo config | `infrastructure/tempo/tempo-config.yml` |
| Alertmanager config (TODO receiver) | `infrastructure/alertmanager/alertmanager.yml` |
| Alert rules | `infrastructure/prometheus/alert-rules.yml` |
| Prometheus configs | `infrastructure/prometheus/prometheus*.yml` |
| Grafana datasources | `infrastructure/grafana/datasources*.yml` |
| Grafana dashboards | `infrastructure/grafana/dashboards/wb-domain.json`, `wb-infra.json` |
| Env vars (infra + backend) | root `.env.example` |
| Env vars (api-consumed subset) | `apps/api/.env.example` |
