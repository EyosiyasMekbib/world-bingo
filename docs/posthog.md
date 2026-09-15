| `apps/web/scripts/posthog-sourcemaps.sh` | build step: inject chunk ids, upload hidden source maps, strip `.map` files |
# World Bingo — PostHog Product Analytics Runbook

> **Scope:** browser events, session replay, server-side money and game events, and the
> historical backfill. **Golden rule:** every integration is **env-gated and a no-op when
> unset** — an empty key means no script, no events, no cost.
>
> Design: `docs/superpowers/specs/2026-09-06-posthog-product-analytics-design.md`.
> The June analytics pipeline (`analytics_events`, admin `/analytics`) is unchanged and still
> fed; PostHog sits beside it.

## 1. Create the project

1. Sign up at https://eu.posthog.com (EU Cloud; the free tier covers 1M events and 5k
   replays a month). One project per environment (`production`, `staging`). Both brands share
   a project and are split by the `brand` property.
2. Project → Settings → copy the **Project API key** (`phc_…`). It is safe to expose to the
   browser; it can only write events.
3. Fill the env vars in Dokploy (or `.env`) for **both** the api and web services:

   | var | where | value |
   |---|---|---|
   | `POSTHOG_KEY` | api | `phc_…` |
   | `POSTHOG_BRAND` | api | `arada` or `betbawa` |
   | `NUXT_PUBLIC_POSTHOG_KEY` | web | the same `phc_…` |
   | `NUXT_PUBLIC_POSTHOG_BRAND` | web | `arada` or `betbawa` |

   `POSTHOG_BRAND` and `NUXT_PUBLIC_POSTHOG_BRAND` **must be set to the same value**. They
   are the `brand` property on server events and browser events respectively; if they
   disagree, one player's history splits across two brands and every brand-filtered
   insight under-counts. Everything else has a working default (`/ingest` proxy, EU hosts,
   replay on).
4. Redeploy api and web. The api logs `[posthog] product analytics enabled` at boot.

## 2. Verify

- Open the player app, browse the lobby, log in. In PostHog → **Activity** you should see
  `$pageview`, `lobby_view`, `user_logged_in` for a person whose distinct id is a UUID with
  `serial`, `brand`, `signup_method` set — and **no** phone number anywhere.
- Network tab: events go to `https://<your-domain>/ingest/…`, never to `posthog.com`
  directly. If they do not, the Nuxt image was built without the default proxy targets.
- **The outbound `/ingest` request must carry no `Cookie` header.** `/ingest` is same-origin,
  so the browser attaches the persisted `auth` cookie — which holds the JWT access and
  refresh tokens and the whole user record — to the request the *browser* makes. The Nitro
  handler at `server/routes/ingest/[...].ts` strips `cookie` and `authorization` before
  forwarding. To check: on the api container, `tcpdump`/proxy logs on the upstream leg, or
  simply confirm the handler is in the build — a `routeRules` proxy would forward the
  cookie, which is why this is a handler and not a route rule.
- **Session replay** → a recording appears within a minute. Every input is masked; the
  profile page's phone line is masked (`data-ph-mask`); uploaded receipts are black boxes.
- Turn replay off without a rebuild: `NUXT_PUBLIC_POSTHOG_REPLAY=false`, redeploy web.

## 3. Event catalog

**Server (authoritative, `apps/api`)** — every one carries `brand`; bots and staff are
dropped before send.

| event | when | key properties |
|---|---|---|
| `user_registered` | phone register, first Telegram auth | `signup_method`, `referred`; sets person `serial`, `created_at` |
| `user_logged_in` | login, returning Telegram auth | `signup_method` |
| `deposit_submitted` | manual receipt or ZareCash checkout row created | `amount`, `method`, `gateway`, `tx_id` |
| `deposit_approved` | credited (manual review or webhook) | `amount`, `method`, `gateway`, `hours_to_approve`, `is_first_deposit` |
| `deposit_rejected` | admin rejected | `amount`, `method`, `reason` (`DUPLICATE_RECEIPT`/`AMOUNT_MISMATCH`/`PAYER_MISMATCH`/`UNREADABLE_RECEIPT`/`NOT_FOUND`/`OTHER`; `null` on backfilled rows), `hours_to_decision`, `has_note` |
| `withdrawal_requested` / `withdrawal_approved` / `withdrawal_rejected` | payout lifecycle | `amount`, `method`, `gateway`, `hours_to_decision` |
| `game_joined` / `game_left` | cartelas bought / refunded before start | `game_id`, `template_id`, `ticket_price`, `cartelas`, `stake`, `spend_account` |
| `game_finished` | one per player when a game ends | `outcome` (`won`/`lost`/`no_winner`), `stake`, `prize`, `net`, `duration_secs` |
| `game_refunded` | game cancelled | `reason`, `refund` |
| `bonus_granted` | any bonus credit | `amount`, `source` (`FIRST_DEPOSIT`/`DEPOSIT_RULE`/`CAMPAIGN`/`CASHBACK`/`ADMIN`), `rule_id` |
| `first_deposit_shared_payer` | a first deposit whose paying account already funded another account's first deposit; first-deposit bonus and referral reward withheld | `matched_on` (`sender_account`/`receipt_payer`), `bonus_blocked` |
| `account_status_changed` | restrict / suspend / reinstate | `from`, `to`, `category`, `has_expiry` |
| `provider_game_launched` | third-party game launch returned a usable URL | `provider_code`, `game_code` |
| `provider_launch_failed` | launch could not produce a playable URL | `provider_code`, `game_code`, `reason` (`vendor_error`, `bad_url`, `provider_inactive`, `game_inactive`) |
| `provider_bet` / `provider_win` | Palace wallet callback committed a bet or a payout | `provider_code`, `game_code`, `round_id`, `bet_id`, `amount`; win adds `round_stake` and `net`; bet adds `spend_account` |
| `password_reset_by_admin` | an admin issued a player a temporary password (support-assisted recovery); distinct id is the player, never the admin | `revoked_sessions` |

**Browser (`apps/web`)** — `$pageview`, `$pageleave`, plus everything `useAnalytics().track()`
already sent: `lobby_view`, `games_lobby_view`, `game_view`, `join_click`,
`deposit_modal_opened`, `deposit_method_selected`, `deposit_amount_entered`,
`provider_game_view`, `provider_session_ended`, `hero_predictions_click`,
`lobby_predictions_click`. Super properties on all of them: `brand`, `locale`, `is_pwa`.

`provider_game_view` also carries `msFromTap`: milliseconds from the lobby tap to the play page, `null` for deep links, reloads and back navigation.

Failure and timing events (added with the retention program, 2026-09-08):

| event | when | properties |
|---|---|---|
| `login_failed` | a sign-in did not complete | `method` (`password` or `telegram`), `reason` (a validation reason such as `password_short`, or the server code: `invalid_credentials`, `account_suspended`, `rate_limited`, `timeout`, `network`), `status` |
| `register_failed` | a registration did not complete | `reason` (`validation_*`, `exists` for "User already exists", or the server code), `status` |
| `deposit_checkout_redirect` | ZareCash checkout created, browser about to leave | `paymentMethod`, `amountBucket`, `ms` (checkout call round trip) |
| `deposit_checkout_failed` | checkout call failed or timed out (15 s) | `paymentMethod`, `amountBucket`, `ms`, `code`, `status`, `timeout` |
| `deposit_submit_blocked` | manual-receipt Submit tapped with fields missing | `paymentMethod`, `missing` (array of `amount`/`transactionId`/`senderName`/`senderAccount`/`receipt`) |
| `deposit_submit_failed` | manual-receipt submit rejected by the api or failed in transit | `paymentMethod`, `code`, `status` |
| `provider_launch_failed` | browser side of a failed launch | `providerCode`, `gameCode`, `code`, `status` |
| `provider_game_loaded` | the game iframe fired `load` | `providerCode`, `gameCode`, `attempt`, `msToLoad` and `msToUrl`, both measured from the start of this attempt's launch call |
| `provider_game_load_timeout` | a load attempt passed 20 s without the frame loading; once per attempt | `providerCode`, `gameCode`, `attempt`, `stage` (`launch` = no launch URL yet, `frame` = URL arrived, frame not loaded), `msToUrl` |
| `provider_game_retry` | the player tapped "Try again" on the play page | `providerCode`, `gameCode`, `attempt` (the new attempt number), `from` (the phase when tapped) |

`describeFailure()` in `apps/web/utils/http-failure.ts` produces `code` / `status` / `timeout`
for all of them, so a failure reason means the same thing on every event.

Password recovery (admin-assisted reset, 2026-09-15). Read with the server's
`password_reset_by_admin`: reset → `user_logged_in` → `password_changed` is the recovery funnel.

| event | when | properties |
|---|---|---|
| `forgot_password_opened` | the login page's "Forgot password?" panel opened | none |
| `password_changed` | the set-password page saved a new password | `forced` (true when support had reset it) |
| `password_change_failed` | the set-password page could not save | `forced`, `reason` (`current_password_incorrect`, `password_unchanged`, or a `describeFailure` code), `status` |

Two session-health events come from the auth store:

| event | properties | meaning |
|---|---|---|
| `session_expired` | `reason`: `refresh_token_invalid` \| `refresh_token_expired` | the client actually cleared a session |
| `session_refresh_failed` | `status`, `transient` | a refresh failed but the session survived |

Watch `session_expired` as a ratio of `user_logged_in`. Before the grace-window fix a third of
all refreshes ended a session (64 of 194 returned 401 and 4 returned 500 in one 4.7-hour
sample), and players were retyping their password several times a day. It should now be a small
fraction; a rise means sessions are being lost again. `session_refresh_failed` is expected to be
non-zero on mobile data and is not a problem on its own — it is the case that used to be treated
as fatal.

`track()` sends **any** name to PostHog; only the allowlisted names above also reach the
custom `/events` endpoint. Add a new browser event by calling `track('new_name', {...})` —
no list to update unless the admin page needs it too.

## 4. Backfill history (once per environment)

Turns existing rows into historical events so retention and lifecycle charts have months of
data on day one. Re-runnable: every event has a deterministic uuid and PostHog de-duplicates.

```bash
cd apps/api
pnpm posthog:backfill -- --since 2026-02-20 --dry-run      # counts only, no network
pnpm posthog:backfill -- --since 2026-02-20                # sends, using POSTHOG_KEY from the root .env
```

Run it **from a machine that can reach the production database** with that environment's
`DATABASE_URL`, `POSTHOG_KEY` and `POSTHOG_BRAND` in the root `.env`. Takes minutes, not hours,
at current volume. Run once per brand (each brand has its own database).

No such machine is needed any more: the API image ships `src/` and `scripts/`, so the same
script runs inside the running `api` container with its own environment (Dokploy: the
compose service, a one-off schedule; or `docker exec`). The runner image has no pnpm, so
call tsx directly:

```bash
cd /app/apps/api && node_modules/.bin/tsx scripts/posthog-backfill.ts --since 2026-02-20
```

What it sends: `user_registered`, deposit/withdrawal lifecycles, `bonus_granted`,
`game_joined` / `game_finished` / `game_refunded`, every row of `analytics_events`, and an
alias linking each anonymous id to the user that later identified. Every backfilled event has
`backfilled: true`. **Decision timing (`hours_to_*`) is null on backfilled events** — the
transactions table records when a row was created, not when it was decided. Those charts start
from the deploy date.

What it cannot send, because no historical source exists:

- **`DEPOSIT_RULE` bonuses.** The other four bonus sources map from a transaction type;
  a deposit-rule grant leaves no distinguishing row, so backfilled `bonus_granted` never
  carries `source: 'DEPOSIT_RULE'`. That source appears only from the deploy date on.
- **`game_left`.** Leaving a game before it starts is not recorded anywhere — the entry row
  is deleted. Backfilled history has `game_joined` with no matching `game_left`, so any
  join→leave funnel is live-only.
- **Cancellation reasons.** Backfilled `game_refunded` carries `reason: 'backfill'`, not the
  real reason, which was never persisted. Filter it out when charting reasons.

`deposit_submitted` rows in `analytics_events` are skipped: the same event is derived from
`transactions`, which is the authoritative copy.

Historical imports show up in PostHog with a delay (minutes to an hour) and are billed as an
import, not as live events.

## 5. The churn dashboard — six insights to build

Create a dashboard "Why are players declining" with these, in this order. Filter every one
by `brand` when comparing brands. Exclude `backfilled = true` from the timing charts (4).

1. **Lifecycle** — Insight type *Lifecycle*, event `game_joined`, weekly. New vs returning vs
   resurrecting vs dormant. Read this first: it says whether the decline is fewer new players
   (acquisition) or more dormant ones (retention).
2. **Retention** — Insight type *Retention*, cohortizing on `user_registered`, returning on
   `game_joined`, weekly, 8 periods. Cross-check against the admin page's cohort matrix.
3. **Acquisition funnel** — *Funnel*: `$pageview` → `user_registered` → `deposit_approved` →
   `game_joined` → `game_joined` (second time), 7-day conversion window, breakdown by
   `signup_method`. The biggest drop is the biggest problem.
4. **Money friction** — two *Trends*: (a) `deposit_rejected` ÷ `deposit_submitted` as a
   formula, breakdown by `method`; (b) median `hours_to_approve` on `deposit_approved` and
   median `hours_to_decision` on `withdrawal_approved`. Slow or failed money is the usual
   first suspect.
5. **"Lost and left" cohort** — *Cohort*: performed `game_finished` where `outcome = lost`
   ≥ 3 times in the last 7 days **and** did not perform `game_joined` in the last 7 days.
   Chart its size weekly. Then open **Session replay**, filter by this cohort, watch ten.
6. **Deposited, never played** — *Session replay* filter: persons who performed
   `deposit_approved` in the last 7 days and did not perform `game_joined` within 24 h.
   Watch ten. This is the fastest way to find a broken screen.

Supporting cuts worth a saved insight each: `game_finished` breakdown by `template_id`
(which games lose players), `account_status_changed` trend (are suspensions rising),
`is_pwa` breakdown on retention (does the installed app retain better).

## 6. Privacy and cost guardrails

- Distinct id is the user UUID. Phone, names, Telegram handles, account numbers, receipt URLs
  and reviewer notes are never sent — by construction in `lib/posthog-events.ts` and
  `utils/posthog.ts`. Keep it that way when adding events.
- **Nothing that identifies a player rides the proxy either.** `/ingest` is a Nitro handler,
  not a route rule, precisely so `cookie` and `authorization` can be stripped before the
  request leaves the box — see §2.
- Replay masks all inputs (`maskAllInputs`), anything with `data-ph-mask`, and blocks
  `/uploads/` images. Masked today: the profile phone line, the login "Welcome back" card,
  support chat message bodies, notification bodies. Add `data-ph-mask` to any new element
  that renders a name, phone, account number, or free text somebody typed — rrweb masks the
  matched element and everything inside it.
- `autocapture` is off. Volume is the named events only; a busy month is well under the
  free tier. Check Settings → Billing monthly.
- To stop everything: clear the two keys and redeploy. Nothing else needs to change.

## 7. Where the code lives

| file | role |
|---|---|
| `apps/web/plugins/02.posthog.client.ts` | SDK init, super props, identify on hydrate |
| `apps/web/composables/useAnalytics.ts` | `track` / `identify` / `reset` dual-sink adapter |
| `apps/web/utils/posthog.ts` | pure helpers (person props, replay flag, brand slug) |
| `apps/web/nuxt.config.ts` | `runtimeConfig.public.posthog`, private `posthog*ProxyTarget` |
| `apps/web/server/routes/ingest/[...].ts` | `/ingest` reverse proxy, strips credential headers |
| `apps/web/utils/posthog-proxy.ts` | pure helpers for that handler (header strip, host split) |
| `apps/api/src/lib/posthog.ts` | env-gated client, bot/staff exclusion, `captureEvent` |
| `apps/api/src/lib/posthog-events.ts` | `emitDepositApproved`, `emitGameFinished`, `emitGameRefunded` |
| `apps/api/src/lib/posthog-backfill.ts` + `scripts/posthog-backfill.ts` | historical import |

## 8. Source maps for error tracking

PostHog's exception autocapture is switched on remotely (project settings →
Error tracking), so the web app reports unhandled errors without any client
config. Without source maps every frame is a minified `_nuxt/XXXX.js:2:641`,
and PostHog's own symbolication attempt fails with "bad json" because the
`.map` it asks for 404s. The web Docker build fixes that:

1. `nuxt.config.ts` sets `sourcemap.client: 'hidden'` — a `.map` beside every
   chunk, no `sourceMappingURL` comment — and turns off `@sentry/nuxt`'s
   source map plugin, which would otherwise delete the maps after its own
   (token-less, skipped) upload.
2. During `nuxt build`, the `nitro:build:before` hook in `nuxt.config.ts` runs
   `scripts/posthog-sourcemaps.sh` on `.nuxt/dist/client/_nuxt`: it stamps a
   chunk id into each JS file and its map, uploads the maps, then deletes
   every `.map` so none ships. It must run there, before Nitro copies the
   client build into `.output/public` and records each asset's size: editing
   assets after that copy serves them truncated (that took production down
   for ten minutes on 2026-09-08).
3. The step is env-gated and never fails the build. No key → "skipping
   upload", maps still stripped. A failed upload logs `UPLOAD FAILED` and
   continues.

### Enable it on a deployment

In the stack's environment (Dokploy → compose → Environment):

```
POSTHOG_CLI_API_KEY=phx_...      # personal API key, scope: error_tracking:write
POSTHOG_CLI_PROJECT_ID=267450    # the number in the PostHog project URL
POSTHOG_CLI_HOST=https://eu.posthog.com
```

Create the key at PostHog → Settings → Personal API keys, scoped to this
organization with only `error_tracking:write`. The compose files pass it to
the web build as a BuildKit **secret** (`/run/secrets/POSTHOG_CLI_API_KEY`),
never as a build arg, so it lands in no image layer. Then redeploy the web
service: the build log shows `posthog-sourcemaps: uploading N source maps`.

### Verify

PostHog → Error tracking → any new issue → the stack trace shows
`components/...vue` frames instead of `_nuxt/XXXX.js`. Symbol sets are listed
under Error tracking → Settings → Symbol sets; a row with a failure reason
means the chunk id in the served JS has no uploaded map (stale image, or the
upload step was skipped for that build).

### Related noise rules (set in PostHog, not in code)

- **Suppression**: `$exception_values` contains `Script error.` — the
  cross-origin placeholder old Android in-app browsers emit. Dropped at
  ingestion.
- **Grouping**: any of `dynamically imported module`, `Importing a module
  script failed`, `Unable to preload CSS` → one issue. Those are chunk loads
  from a tab opened before a deploy rotated the `_nuxt` hashes; Nuxt reloads
  the page (`experimental.emitRouteChunkError: 'automatic-immediate'`), so
  they are recovered, not fatal.

## 9. Retention watchlists (cohorts)

Two dynamic cohorts, created 2026-09-08, recalculate on their own:

- **VIP depositors**: an approved deposit of 1,000+ ETB in the last 30 days. Nine such
  players produced 46% of deposit volume in the first 40 hours of tracking.
- **Quiet VIPs**: VIP depositors with no `$pageview` in the last 3 days. The daily win-back
  list. Open it, reach out personally.

Both live under Cohorts in the PostHog project. Filter any insight or replay list by them.

## 10. Money-correctness checks

### 10.1 Provider payout reconciliation (PostHog vs wallet ledger vs Palace)

PostHog's `provider_bet` / `provider_win` are emitted post-commit from `PalaceWalletService`, so they
should match the ledger exactly, except that a cancelled bet keeps its `provider_bet` (cancels emit
nothing). `scripts/reconcile-provider-rounds.ts` prints the ledger side; all its SQL runs in a
READ ONLY transaction.

1. **Run the ledger side inside the production api container** (Dokploy → aradabingo → production →
   app → container `aradabingo-app-wn5mzb-api-1` → Terminal, or `docker exec -it aradabingo-app-wn5mzb-api-1 sh`
   on the host):
   ```sh
   cd /app/apps/api
   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-08-31 --until 2026-09-14
   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-08-31 --until 2026-09-14 --game aviator --top 30
   ```
2. **Run the PostHog side for the same window** (HogQL, `mcp__posthog__exec` → `execute-sql`, or the SQL editor):
   ```sql
   SELECT
     properties.game_code AS game,
     countIf(event = 'provider_bet') AS bets,
     sumIf(toFloat(properties.amount), event = 'provider_bet') AS wagered,
     countIf(event = 'provider_win') AS wins,
     sumIf(toFloat(properties.amount), event = 'provider_win') AS paid
   FROM events
   WHERE timestamp >= toDateTime('2026-08-31 00:00:00')
     AND timestamp < toDateTime('2026-09-14 00:00:00')
     AND event IN ('provider_bet', 'provider_win')
     AND properties.provider_code = 'palace'
     AND properties.game_code IN ('aviator', 'chicken-road', '313')
   GROUP BY game
   ```
3. **Compare.** Failed bets emit nothing and cancelled bets keep their `provider_bet`, so PostHog `bets`
   should equal ledger `bets + rolledBackBets`, and PostHog `wagered` should equal
   `posthogComparableWagered`. PostHog `wins`/`paid` should equal ledger `wins`/`paid`. Allow 1 ETB per
   game for rounding, and a few rows at the window edges because PostHog `timestamp` is capture time
   and the ledger uses `createdAt`.
4. **Decide.**
   - Integrity table shows any non-zero count → double-write defect in the wallet code. Stop and open a bug with the window and game.
   - Ledger and PostHog differ beyond step 3's allowance → an emit gap. Compare the round lists (`--game`) against PostHog `round_id`s for one day.
   - Ledger and PostHog agree → run step 5 to bring in Palace.
5. **Diff against Palace for one day at a time** (Palace's agent API pages every game):
   ```sh
   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-09-12 --until 2026-09-13 --game aviator --palace --top 50; echo "exit=$?"
   ```
   - `exit=0`: Palace's own record agrees with our wallet round by round. Aviator's hold is what players actually lost (cashouts not made); treat it as a product/UX issue (P1 #10, provider game load on Android), not a payout bug.
   - `exit=2` with `palace_only` or `amount_mismatch` rows where `palacePaid > ledgerPaid`: Palace booked cashouts our wallet never credited. Take those `roundId`s to step 6 and escalate.
   - Many `palace_only` rows with `palacePaid = 0` near midnight: window edge (Palace's time zone); widen `--since/--until` by a day and re-run.
6. **Read the raw callbacks for a disputed round.** The callback route logs every request as
   `[Palace] callback received` (full body) and `[Palace] callback handled` (command, data, result):
   ```sh
   docker logs --since 48h aradabingo-app-wn5mzb-api-1 2>&1 | grep '\[Palace\] callback handled' | grep '"round_id":"<roundId>"'
   docker logs --since 48h aradabingo-app-wn5mzb-api-1 2>&1 | grep '\[Palace\] callback handled' | grep '"command":"win"' | grep -v '"result":0' | head -50
   docker logs --since 48h aradabingo-app-wn5mzb-api-1 2>&1 | grep -E 'palace-settlement|palace-idempotency-mismatch|palace-fraud-flag' | head -50
   ```
   With Loki shipping enabled, the Grafana equivalent is
   `{app="world-bingo-api-arada"} |= "[Palace] callback handled" |= "\"command\":\"win\""`.
   Container logs do not survive a redeploy, and Dokploy's `compose.readLogs` `search` returned HTTP 500
   during the 2026-09-14 investigation — use the host shell or Grafana.

### 10.2 Duplicate accounts and first-deposit incentive farming

The first-deposit bonus and the referral reward are withheld when the paying account (player-entered
`senderAccount`, or the parsed receipt's masked number + payer name) already funded another account's
first deposit. Incentives are also withheld if the paying-account lookup or lock fails; these failures log
`[WalletService] first deposit ... payer` errors to GlitchTip and do not emit `first_deposit_shared_payer` events to PostHog.
Hosted ZareCash checkouts carry no payer, so they are never matched. Upstream fix: phone-OTP password reset (P1), 
which removes the reason locked-out players open second accounts.

1. **Admin listing** (admin bearer token from an admin login session):
   ```sh
   curl -s "https://api.aradabingo.bet/admin/fraud/shared-payers?days=14&limit=100" -H "Authorization: Bearer $TOKEN" \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).clusters;const by={};for(const x of c)by[x.signal]=(by[x.signal]||0)+1;console.log(by);console.log(JSON.stringify(c.slice(0,5),null,2))})'
   ```
   The listing caps how many `receipt_payer` groups it scans, so a `receipt_payer` cluster beyond the cap may not be shown; use a narrower `days` window to reduce the scan.
2. **Devices shared by newly registered accounts** (baseline 2026-09-14: 119 devices, 256 persons, max 5 on one device):
   ```sql
   SELECT count() AS devices_with_multiple_persons, sum(persons) AS persons_on_those_devices, max(persons) AS max_persons_one_device
   FROM (
     SELECT properties.$device_id AS device, uniq(person_id) AS persons
     FROM events
     WHERE timestamp >= now() - INTERVAL 14 DAY
       AND event = '$pageview'
       AND properties.$device_id IS NOT NULL
       AND person_id IN (SELECT person_id FROM events WHERE timestamp >= now() - INTERVAL 14 DAY AND event = 'user_registered')
     GROUP BY device
     HAVING persons > 1
   )
   ```
3. **First depositors on those devices** (baseline 2026-09-14: 83):
   ```sql
   SELECT count(DISTINCT person_id) AS first_depositors_on_shared_devices
   FROM events
   WHERE timestamp >= now() - INTERVAL 14 DAY
     AND event = 'deposit_approved'
     AND properties.is_first_deposit = true
     AND person_id IN (
       SELECT person_id FROM events
       WHERE timestamp >= now() - INTERVAL 14 DAY
         AND event = '$pageview'
         AND properties.$device_id IN (
           SELECT properties.$device_id FROM events
           WHERE timestamp >= now() - INTERVAL 14 DAY AND event = '$pageview' AND properties.$device_id IS NOT NULL
           GROUP BY properties.$device_id
           HAVING uniq(person_id) > 1))
   ```
4. **Guard effect** (after the guard is deployed):
   ```sql
   SELECT event, properties.source AS source, properties.matched_on AS matched_on, properties.bonus_blocked AS bonus_blocked,
          count() AS n, uniq(person_id) AS accounts
   FROM events
   WHERE timestamp >= now() - INTERVAL 14 DAY
     AND (event = 'first_deposit_shared_payer' OR (event = 'bonus_granted' AND properties.source = 'FIRST_DEPOSIT'))
   GROUP BY event, source, matched_on, bonus_blocked
   ```
   `first_deposit_shared_payer` rows are farming attempts caught. Compare `accounts` with step 3: first depositors on shared
   devices that the guard did not catch paid through a hosted checkout, a different wallet, or were blocked by a payer lookup or lock failure (check GlitchTip for `[WalletService] first deposit` errors). Keep
   `first_deposit_bonus_amount` at 0 (P1 #9) until this has run for 7 days and step 1's counts have been reviewed.
