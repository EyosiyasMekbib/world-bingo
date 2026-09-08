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
| `deposit_rejected` | admin rejected | `amount`, `method`, `hours_to_decision`, `has_note` |
| `withdrawal_requested` / `withdrawal_approved` / `withdrawal_rejected` | payout lifecycle | `amount`, `method`, `gateway`, `hours_to_decision` |
| `game_joined` / `game_left` | cartelas bought / refunded before start | `game_id`, `template_id`, `ticket_price`, `cartelas`, `stake`, `spend_account` |
| `game_finished` | one per player when a game ends | `outcome` (`won`/`lost`/`no_winner`), `stake`, `prize`, `net`, `duration_secs` |
| `game_refunded` | game cancelled | `reason`, `refund` |
| `bonus_granted` | any bonus credit | `amount`, `source` (`FIRST_DEPOSIT`/`DEPOSIT_RULE`/`CAMPAIGN`/`CASHBACK`/`ADMIN`), `rule_id` |
| `account_status_changed` | restrict / suspend / reinstate | `from`, `to`, `category`, `has_expiry` |
| `provider_game_launched` | third-party game opened | `provider_code`, `game_code` |

**Browser (`apps/web`)** — `$pageview`, `$pageleave`, plus everything `useAnalytics().track()`
already sent: `lobby_view`, `games_lobby_view`, `game_view`, `join_click`,
`deposit_modal_opened`, `deposit_method_selected`, `deposit_amount_entered`,
`provider_game_view`, `provider_session_ended`, `hero_predictions_click`,
`lobby_predictions_click`. Super properties on all of them: `brand`, `locale`, `is_pwa`.

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
2. After `nuxt build`, `scripts/posthog-sourcemaps.sh` runs
   `posthog-cli sourcemap process` on `.output/public/_nuxt`: it stamps a
   chunk id into each JS file and its map, uploads the maps, then deletes
   every `.map` so none ships.
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
