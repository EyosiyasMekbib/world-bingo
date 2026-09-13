---
name: atlasv-integration-playbook
description: Debug, deploy, and verify fixes for the Atlas-V game-provider integration against real Atlas-V traffic and Dokploy staging/production. Use when Atlas-V callbacks fail signature verification, a game won't launch, games don't show in the lobby, or when deploying/verifying any Atlas-V-related change through Dokploy. Trigger on "Atlas-V", "atlasv", "atlas-v.com test tool", game-provider callback failures, or Dokploy deploy-queue questions for this repo.
---

# Atlas-V integration playbook

Not a run-the-app skill — Atlas-V is a third-party game provider integrated
into `apps/api`, not a standalone service to launch. This is the operational
runbook for the live debug loop that actually shipped every fix in this
integration: real requests against Atlas-V's own test tool, real staging
logs, real Dokploy deploys.

## Architecture — read first if unfamiliar

`docs/superpowers/specs/2026-09-09-atlasv-integration-design.md` has the full
design (decisions table, file map, data model). Don't duplicate it here — the
five files that matter for debugging:

| File | Role |
|---|---|
| `apps/api/src/gateways/game-provider/atlasv-signature.ts` | Hash sign/verify. `canonicalHashInput()` is the exact wire format. |
| `apps/api/src/gateways/game-provider/atlasv.gateway.ts` | Outbound: `/init` (launch), `/freespin` (grant). |
| `apps/api/src/services/atlasv-wallet.service.ts` | Inbound wallet logic: bet/betwin/result/rollback/bulkresult/freespin/jackpot. |
| `apps/api/src/routes/atlasv/callback.ts` + `callback-helper.ts` | Inbound HTTP routes, signature check, hub/spoke forward. |
| `apps/api/prisma/seed.ts` (search `Atlas-V`) | The ENTIRE game catalog — Atlas-V has no listing API, so every playable game is a hand-added row here. |

**Ground truth is the PDF, not memory or prior summaries**: `~/Documents/v4.pdf`
(Atlas-V's own API doc). When behavior is ambiguous, re-`Read` it directly —
it's short (9 pages, one endpoint per page with a worked request/response
example). Prior conversation summaries about "what the spec says" have been
wrong before; the PDF hasn't.

## The live debug loop

This is the actual procedure, run repeatedly and successfully in this
session:

1. User drives Atlas-V's real test tool (`https://atlas-v.com/test/`) against
   our staging callback base, `https://staging-api.aradabingo.bet/v1/atlasv/callback/*`
   (or hits `/init` indirectly by launching a game in the staging lobby).
2. They paste the request/response transcript, or just report a symptom
   ("game won't launch", "games don't show up").
3. Pull the real api container's logs and find the actual error — **never
   guess a cause without reading the log first**:
   ```
   mcp__dokploy-mcp__compose-readLogs
     composeId: <staging composeId>
     containerId: <appName>-api-<suffix>-1   # e.g. arada-staging-app-nir9nv-api-arada-stg-1
     search: "provider launch failed"        # or "Atlas-V", "atlasv", etc.
     tail: 20
   ```
   A wrong-but-plausible hypothesis wasted a round-trip here at least once
   (see Gotchas — private key vs. player-not-found). Read the log before
   proposing a fix.
4. Fix the code, run the relevant test file(s) under `apps/api/src/test/atlasv-*.test.ts`,
   commit, then push to **both** `main` and `staging`:
   ```
   git push origin main
   git push origin main:staging
   ```
   (`main` auto-deploys production for both brands; `staging` auto-deploys
   the staging environments — see Dokploy section. Pushing both keeps
   production from drifting behind staging once a fix is confirmed good.)
5. Verify the deploy actually landed (see Dokploy section), then tell the
   user it's live and to retry.
6. Repeat from step 1 for the next symptom.

## Known failure signatures → fixes

Real bugs hit and fixed this way. If a new symptom doesn't match one of
these, go back to step 3 (read the log) rather than pattern-matching to the
closest one below.

- **Every callback fails signature verification, no exceptions.**
  Check `ATLASV_CALLBACK_DEBUG=true` output (or the log line directly) for
  `ATLASV_PRIVATE_KEY is empty`. Compose only forwards env vars a service
  explicitly declares — `ATLASV_*` has to be in the `environment:` block of
  every `docker-compose*.yml` that defines the `api` service, not just set
  in Dokploy's panel. (Fixed in `f949cdb`.)

- **`/bet`, `/rollback`, `/result`, `/betwin` throw an unhandled error, but
  `/account` works fine.** `Error: Provider 'atlasv' not seeded in DB` — the
  `GameProvider` row doesn't exist yet in that environment's DB (a fresh env,
  or a DB reset). Fix: toggle `RUN_SEED=true` on the compose, redeploy once,
  then set it back to `false` — see `DEPLOYMENT.md`'s documented one-time-seed
  procedure. `/account` doesn't need the provider row, which is why it's the
  one exception.

- **Signature always fails against REAL Atlas-V traffic, but the unit tests
  pass.** The unit tests only exercise our own signing, so a canonicalization
  bug can hide there. Capture 2-3 real `(full request body, hash)` pairs from
  staging logs and brute-force which JSON-construction variant reproduces the
  hash locally (a throwaway Node script trying candidates is faster than
  guessing). The confirmed real formula:
  `sha1(JSON.stringify(bodyMinusHashAndTimestamp) + PRIVATE_KEY + timestamp)`
  — **timestamp is excluded from the hashed JSON and appended raw**, not left
  inside it (their doc's own notation is ambiguous on this point). Locked in
  as a regression test in `atlasv-signature.test.ts` using one of the
  captured real requests — don't delete that test even if it looks redundant
  with the synthetic ones.

- **`/bulkresult` specifically fails signature verification even though
  every other action passes.** Its hash is computed **without the `data`
  array** in the body — the one documented exception in Atlas-V's own spec
  text (not in the original PDF; only in the later, fuller spec text pasted
  into this session). `verifyAtlasVBody`/`debugAtlasVHash` take an optional
  `excludeField` param for exactly this.

- **A provider's games exist in the DB (confirmed via
  `GET /admin/providers/atlasv/games`) but don't appear anywhere in the web
  lobby.** Check `imageSquare`/`imageLandscape` on the `ProviderGame` row.
  All three lobby pages (`apps/web/pages/index.vue`, `games/index.vue`,
  `games/[category].vue`) historically dropped any game with both null
  before it reached the template — silent, no error anywhere. This bites
  **any** hand-seeded, no-listing-API provider (Atlas-V today; the next one
  will hit it too) since there's no automatic artwork source. Fixed by
  rendering a letter/glyph placeholder tile instead of filtering — don't
  reintroduce the filter when adding new games; give them a placeholder or
  real art, never silence.

- **A game launches "This game could not be started right now" (502
  GameLaunchFailed) — that message alone.** It's a generic wrapper; the real
  cause is server-logged, not client-visible. Check
  `apps/api/src/routes/game-provider/index.ts`'s `provider launch failed`
  log line for the actual `AtlasVApiError.message`. If the message is a bare
  `HTTP 5xx` with no body, `atlasv.gateway.ts`'s `request()` didn't capture
  the response text — it does now (reads and truncates the upstream body
  into the error message), so a stale deploy is the likely cause; redeploy
  and retry before assuming there's a new bug.

- **`/init` crashes on Atlas-V's own end**: `TypeError: Cannot read
  properties of undefined (reading 'casino_id')` (Express's default
  unhandled-exception page). This is the classic "no body-parser registered
  for this Content-Type" symptom. The PDF spec mandates
  `Content-Type: text/javascript` for every request, but Atlas-V's real
  `/init` doesn't parse it — send `application/json` outbound instead (our
  own inbound callback receiver already accepts both, for the same reason in
  reverse). If a *future* endpoint shows the same crash shape, suspect the
  same Content-Type mismatch before anything else.

## Dokploy operational notes

- **The env panel is write-only** — `compose-one`'s `env` field and even a
  running container's `docker-getConfig` `Config.Env` always return
  `"[REDACTED]"`. There is no way to read the current `.env` file's content
  before writing. **Never call `compose-saveEnvironment`** — it replaces the
  whole file, and a partial write silently drops every other secret
  (`JWT_SECRET`, `DATABASE_URL`, ...). Always hand the user the exact
  variable lines to paste in manually, appended to what's already there.

- **`main` deploys production, `staging` deploys staging — for both brands,
  from one repo.** There is no per-brand branch; `docker-compose.prod.yml`
  vs `docker-compose.*.staging.yml` is selected by which compose in Dokploy
  tracks which branch. Pushing to `main` alone silently ships to production.
  If a fix is only confirmed on staging, don't push `main` yet.

- **Verifying a deploy landed** — `composeStatus` on `compose-one` lags
  reality; check the specific deployment entry instead:
  1. `deployment-queueList` — if your commit's job is gone, move to step 2.
  2. `compose-one` with the composeId, find the `deployments[]` entry whose
     `description` matches `Commit: <sha>`. `status: "done"`, `errorMessage:
     null` means it shipped. `status: "error"` — see below.
  3. If it still shows `"running"`, use `deployment-readLogs` with that
     entry's `deploymentId` and look for `"Docker Compose Deployed: ✅"` at
     the end of the live build log.
  4. Confirm the container actually restarted:
     `docker-getContainersByAppNameMatch` with the compose's `appName` —
     the api container's "Up X minutes" should be small, and its state
     `running`/`healthy`, not `created`.

- **Deploy status `"error"`, container stuck in `state: "created"`
  (never started), build log ends with `Error response from daemon: failed
  to set up container networking: Address already in use`.** Not a code
  bug — a leftover container from a previous failed attempt is still
  holding the network slot the new one needs. Fix:
  `docker-removeContainer` on the stuck container (safe — it never started,
  holds no state, isn't serving traffic), then `compose-redeploy` on the
  same composeId. Confirmed twice in this session; a second `compose-redeploy`
  alone without removing the stuck container just fails the same way again.

- **The deploy queue is shared across every project and compose on the
  Dokploy instance.** A push can sit behind an unrelated brand's production
  build. `deployment-queueList` shows every pending job (`state: "waiting"`
  or `"active"`) — don't assume your job is next just because you just
  pushed.
