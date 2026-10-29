# IGCORE sportsbook: onboarding form and go-live steps

Winner only. Arada has no sportsbook and none of its compose files carry an `IGCORE_*` variable.

This page has three jobs: the form we send to IGCORE, the env lines to paste into Dokploy, and
what to do once the build is deployed. Design background is in
`docs/superpowers/specs/2026-10-28-igcore-sportsbook-design.md`.

## 1. Onboarding form (draft for IGCORE)

Send the staging column first. The production column is for later, after staging is proven.

| Field | Staging | Production |
|---|---|---|
| Server IP(s) we call from | `72.62.234.120` (to be confirmed, see section 2) | To confirm: run `wget -qO- https://api.ipify.org` inside the Winner prod api container (section 2) |
| Callback URL | `https://staging-api.betbawa.bet/v1/igcore` | `https://api.dash1.games/v1/igcore` |
| Website URL | `https://staging.betbawa.bet` | `https://winneret.cc` |
| Currencies | ETB | ETB |
| Languages | en, am | en, am |
| Account options | `info`, `ticketId`, `details`, `rollbackAction`, `sendLose` | `info`, `ticketId`, `details`, `rollbackAction`, `sendLose` |

IGCORE posts to `<callback URL>/transaction` and `<callback URL>/transaction-rollback`.

Notes for whoever fills in the form:

- **Options are fixed.** Changing them later costs another IGCORE cycle. `ticketId` links results
  and rollbacks to the bet. `details` is needed for partial cashouts, whose remainder continues
  under a new ticket id. `rollbackAction` removes guesswork in rollbacks. `sendLose` gives a
  complete ledger. We do not request `freebet`, `links`, `paths`, `username` or `timeout`.
- **Languages.** IGCORE may not offer Amharic, or may spell the code differently. `en` is the
  fallback (`IGCORE_DEFAULT_LANG`).
- **Framing.** The sportsbook runs in an iframe on our site. The website URL on the form is
  presumably what IGCORE allow-lists for framing. Check this with the first real session.

## 2. Confirm the egress IP before sending the form

IGCORE allow-lists the address we call from (`/auth` and `/start-session`). The staging value
`72.62.234.120` is the Dokploy host's address, but the address a container reaches the internet
from is what counts. Confirm it from inside the api container:

```sh
wget -qO- https://api.ipify.org
```

Use `wget`: the api image is `node:22-alpine`, which has busybox `wget` but no `curl`, and the
container runs as a non-root user, so `curl` cannot be installed there. (The compose healthcheck
already depends on `wget`.)

Run it in the staging api container (compose service `api-betbawa-stg`) for the staging column,
and in the Winner production api container (compose service `api-betbawa`) for the production
column. Dokploy's container terminal or `docker exec -it <container> sh` both work.

If the staging answer is not `72.62.234.120`, put the answer on the form instead. The production
address is not known yet and is not assumed to match the staging one: put whatever the production
container reports on the production column.

## 3. Env lines to paste into Dokploy

Paste these into the Dokploy Environment panel by hand and redeploy; we have no API access to it.
Open the panel for the right compose project and append the lines below to what is already there
(do not replace the existing contents).

The compose files already forward every `IGCORE_*` variable with safe defaults, so with nothing
set the integration is inert: players see "Sports is unavailable right now".

### 3a. Simulator mode (Winner staging, before IGCORE answers)

The API mounts its own stand-in IGCORE at `/v1/igcore-sim` and calls itself. Generate the three
secrets on your own machine and paste the output; never commit them:

```sh
openssl rand -hex 24   # IGCORE_USERNAME
openssl rand -hex 24   # IGCORE_PASSWORD
openssl rand -hex 32   # IGCORE_SECURITY_HASH
```

```sh
IGCORE_SIMULATOR=true
IGCORE_API_URL=http://127.0.0.1:8080/v1/igcore-sim
IGCORE_USERNAME=<output of the first openssl command>
IGCORE_PASSWORD=<output of the second openssl command>
IGCORE_SECURITY_HASH=<output of the third openssl command>
IGCORE_SIM_PUBLIC_URL=https://staging-api.betbawa.bet
```

- `IGCORE_API_URL` is loopback inside the api container: the API calls its own simulator. The
  client appends `/<IGCORE_API_VERSION>/auth` and `/start-session`, which the simulator serves
  under `/1.0.0/`.
- `IGCORE_SIM_PUBLIC_URL` is the origin a player's browser uses to reach the simulator's book page.
- Leave `IGCORE_SIM_CALLBACK_URL` unset. It then defaults to `http://127.0.0.1:8080/v1/igcore`
  (the compose files fix `PORT` at 8080), which is where the simulator posts its signed callbacks.
- **The simulator mints wallet credit.** Before turning it on, confirm staging's `DATABASE_URL`
  and `REDIS_URL` are not production's.
- It is declared in `docker-compose.betbawa.staging.yml` only. The production compose file does
  not declare `IGCORE_SIMULATOR`, `IGCORE_SIM_PUBLIC_URL` or `IGCORE_SIM_CALLBACK_URL`, so setting
  them there does nothing. The API logs a warning at startup while the simulator is on.

### 3b. Real IGCORE (staging or production)

```sh
IGCORE_SIMULATOR=false
IGCORE_API_URL=<from IGCORE>
IGCORE_USERNAME=<from IGCORE>
IGCORE_PASSWORD=<from IGCORE>
IGCORE_SECURITY_HASH=<from IGCORE>
```

- `IGCORE_SIMULATOR=false` applies to staging only; you may delete the line instead. Production
  never declares it.
- `IGCORE_API_URL` is the base URL without the version segment.
- `IGCORE_API_URL`, `IGCORE_USERNAME`, `IGCORE_PASSWORD` and `IGCORE_SECURITY_HASH` all come from
  IGCORE once they answer the form. Until all four are set the integration stays off, and with no
  `IGCORE_SECURITY_HASH` every callback is rejected.
- Moving from simulator mode to real IGCORE replaces those four values; do not keep the generated
  ones.

Optional, with their defaults:

| Variable | Default | Meaning |
|---|---|---|
| `IGCORE_API_VERSION` | `1.0.0` | Path prefix after the base URL |
| `IGCORE_CURRENCY` | `ETB` | Currency sent and accepted |
| `IGCORE_DEFAULT_LANG` | `en` | Language when the player's is not supported |
| `IGCORE_MAX_WIN_AMOUNT` | `1000000` | Per-callback payout cap; `0` disables it |
| `IGCORE_MAX_TICKET_PAYOUT` | `1000000` | Cumulative payout cap per ticket; `0` disables it |
| `IGCORE_CALLBACK_DEBUG` | `false` | Log the raw body and expected/received hash on a signature failure |

## 4. After the deploy

1. **Turn Sportsbook on.** In the admin app, Settings, Features, switch **Sportsbook** on. This
   sets `feature_sportsbook`, which defaults to off. While it is off the Sports nav item is hidden
   and `/sports` is unavailable, whatever the env says.
2. **Run the go-live checklist (simulator mode only).** With an admin bearer token:

   ```sh
   curl -s -X POST https://staging-api.betbawa.bet/v1/igcore-sim/checklist \
     -H "Authorization: Bearer <admin access token>"
   ```

   It runs every callback item of IGCORE's go-live checklist (section 7 of their spec) against a throwaway player
   (`igcore-check-<timestamp>`, minted a starting balance, audited as an admin adjustment) and
   returns `{ passed, failed, results }` with balance deltas. The route exists only while
   `IGCORE_SIMULATOR=true`; without it the path is a 404. `503` means `IGCORE_SECURITY_HASH` is
   unset. Follow it with one clicked-through bet, win and rollback on `/sports`, checking balances.
3. **Know the two log tags.** Search the api container logs for them:
   - `[igcore-fraud-flag]`: a callback needs a human look, such as a payout held over a cap (nothing
     credited, IGCORE is asked to retry), a result with no recorded bet, or an id that belongs to
     another player.
   - `[igcore-rollback-shortfall]`: rolling back a result found less real balance than it paid out
     (the player had withdrawn); we took what was there, answered success, and the rest is netted
     off the next result on that ticket.
