# World Bingo Agent Network - Operator Runbook

> **Scope:** what the agent network is, how to run it day to day, and how to deploy the
> agent app for each brand.
> **Golden rule:** cash never touches the platform. The platform only ever moves *float*
> and *player balance*. Every banknote stays between the agent and the player.

---

## 1. What the network is

An agent is a person with a counter and a cash box. They sell your credit.

The money runs in one direction only:

1. **The agent pre-pays you, in cash.** Bank transfer, mobile money, or notes in your hand.
   This happens entirely off the platform.
2. **You issue float** for what you received, **plus a commission bonus on top**. The bonus is
   the agent's margin: it is theirs to sell, and it is the whole reason they do this.
3. **The agent credits players.** A player walks up, hands the agent cash, and the agent
   credits that player's wallet. The agent's float goes down, the player's balance goes up.
4. **The cash stays with the agent.** You never see it, never hold it, never settle it.

Worked example, with the commission rate at 5 percent:

| Step | Agent cash | Agent float | Your position |
|---|---|---|---|
| Agent pays you 10,000 | -10,000 | 0 | +10,000 cash received |
| You issue float | -10,000 | 10,500 | 10,500 of credit outstanding |
| Agent sells all of it at the counter | +10,500 | 0 | 0 outstanding |
| Agent's margin | **+500** | | |

So the platform's exposure at any moment is exactly **the float outstanding**: credit you have
issued but the agent has not yet sold. It is not revenue. You were paid for it up front.

---

## 2. Creating an agent and issuing float

In the **admin app**, under **Management > Agents**.

Both **ADMIN** and **SUPER_ADMIN** can create an agent and issue float. This is deliberate:
issuing float is a daily counter operation, not a privileged one-off, and gating it behind
SUPER_ADMIN would mean the one account that cannot be re-created by an admin becomes the
bottleneck for routine work.

The order of operations matters:

1. **Take the cash first.** Confirm the transfer has actually landed, or that the notes are in
   the box. Float issued against a promise is an unsecured loan.
2. **Create the agent** in Management > Agents.
3. **Issue float** for the amount of cash you received. The commission bonus is applied on top
   automatically, from `agent_commission_rate` (see section 4) - you enter what you were paid,
   not what the agent ends up with.

There is no dedicated reference column. Each issuance writes a free-text `note` onto the
ledger row, and that note is what section 6's reconciliation depends on, so put the bank
reference or receipt number in it every time. A blank note makes an issuance impossible to
match back to a payment later.

---

## 3. There is no automatic reversal, and that is on purpose

If float is issued wrongly, or an agent credits the wrong player, **nothing unwinds itself**.
There is no reversal button and no compensating job.

A mistake is corrected by an admin performing **two deliberate actions**:

1. **Debit the agent's float** by the amount in question.
2. **Adjust the player's wallet** by the same amount.

Two actions, not one, because the two sides of a counter mistake are not always the same
amount and not always both wrong. An automatic reversal would guess, and would move money on
both sides on the strength of that guess. Doing it by hand means each leg lands as its own
audited wallet mutation, with its own `balanceBefore` / `balanceAfter` on the transaction
record, and someone's name against it.

Practical consequence: **check before you issue, not after**. Correcting float is more work
than issuing it.

---

## 4. The settings that govern it

All four are `SiteSetting` rows (a plain key and string value). No redeploy, no env var, no
restart.

> **There is no admin screen for these yet.** The API exposes
> `GET`/`PUT /admin/agents/settings`, and the agent detail page reads the commission rate
> from it to prefill the issue-float form, but nothing writes them back. Until that screen
> exists, change them directly in the `site_settings` table, or call the `PUT` endpoint.
> `agent_code_ttl_seconds` is not accepted by that endpoint at all, so it is table-only.

| Key | What it controls |
|---|---|
| `agent_commission_rate` | The bonus added on top of the float an agent buys. This is the agent's entire margin, so it is also your main lever on how hard they sell. |
| `agent_deposit_min` | Smallest single deposit an agent may credit to a player. Floors out the bonus-farming pattern described in section 6. |
| `agent_deposit_max` | Largest single deposit an agent may credit to a player. Caps the blast radius of one bad or mistaken credit. |
| `agent_code_ttl_seconds` | How long a deposit code stays valid, in seconds. Short enough that a code left on a screen or shouted across a room has expired by the time anyone else tries it. |

Units and shipped defaults:

| Key | Unit | Default |
|---|---|---|
| `agent_commission_rate` | **Percent**, not a fraction. `5` means five percent. | `5` |
| `agent_deposit_min` | ETB | `50` |
| `agent_deposit_max` | ETB | `5000` |
| `agent_code_ttl_seconds` | Seconds | `900` (15 minutes) |

The commission rate is the one to be careful with. Writing `0.05` instead of `5` does not
error, it just pays every agent a hundredth of what you intended, and you will find out from
the agents rather than from the system.

---

## 5. Deployment

The agent app is **one `apps/agent` deployment per brand**, deployed exactly like the admin
app and for the same reason: each brand's agent traffic must reach *that brand's* API and no
other.

Conventions this repo already follows, which the agent app inherits:

- **Per-brand services are suffixed** `-arada` / `-betbawa`, so their network aliases do not
  collide on the shared `dokploy-network`. So: `agent-arada`, `agent-betbawa`.
- **Central shared services are prefixed `wb-`** (`wb-loki`, `wb-tempo`, `wb-glitchtip`). The
  agent app talks to none of them directly except through the Sentry SDK.
- **Image tags are suffixed with the brand** (`world-bingo-agent:arada`) so a rebuild of one
  brand does not clobber another.
- **No host port is published.** Attach a Dokploy domain to the service and point it at
  container port **3003**.

The agent app renders client-side (`ssr: false`) and keeps its session token in the browser's
local storage rather than a cookie, so unlike the admin it needs no server-side API base and no
JWT secret of its own. Nitro still runs in the container, which is what serves the `/api` and
`/socket.io` proxies, so it is still started with `node .output/server/index.mjs` and still
needs its own process. It is not a static bundle you can drop on a CDN.

The critical build argument:

```
NUXT_API_PROXY_TARGET=http://api-arada:8080     # arada
NUXT_API_PROXY_TARGET=http://api-betbawa:8080   # betbawa
```

Nuxt bakes `routeRules` proxies at **build time**, so this is a build arg and not a runtime
variable. Changing it means rebuilding the image. Leave it at its default `http://api:8080`
and the agent app resolves the bare `api` alias on `dokploy-network`, which belongs to
whichever unrelated stack answers first. That failure is quiet: the app boots, the pages
render, and every request goes to somebody else's API.

The services are already in all four brand compose files (`docker-compose.aradabingo.yml`,
`docker-compose.betbawa.yml` and the two staging variants), each mirroring that brand's
`admin-*` service and validated with `docker compose config`. For reference, the arada one
reads:

```yaml
  agent-arada:
    build:
      context: .
      dockerfile: apps/agent/Dockerfile
      args:
        NUXT_API_PROXY_TARGET: http://api-arada:8080
    image: world-bingo-agent:arada
    restart: unless-stopped
    environment:
      # Same-origin: every agent call goes through the app's own /api proxy.
      # This is already the built-in default; it is spelled out here so that
      # changing it is a visible edit rather than a rebuild nobody notices.
      NUXT_PUBLIC_API_BASE: /api
      NUXT_PUBLIC_SENTRY_DSN: ${NUXT_PUBLIC_SENTRY_DSN:-}
      NUXT_PUBLIC_SENTRY_ENVIRONMENT: ${NUXT_PUBLIC_SENTRY_ENVIRONMENT:-production}
    depends_on:
      api-arada:
        condition: service_healthy
    networks:
      - internal
      - dokploy-network
```

> **TODO:** decide the public hostname for each brand's agent app (the admin apps use an
> `admin.` prefix on the brand domain) and map it in Dokploy to port 3003 of the service.

CI builds the image on every push to `main` through the `app` matrix in
`.github/workflows/ci.yml`, alongside `api`, `web` and `admin`. The matrix does not override
`fail-fast`, so a failing agent build cancels its three siblings: a broken agent app costs you
the whole image build, not just its own.

Errors from the agent app land in GlitchTip through the shared `NUXT_PUBLIC_SENTRY_DSN`, the
same DSN the web and admin apps use. An empty DSN keeps reporting completely inert. See
`docs/observability.md` for the rest of the stack.

---

## 6. What to watch

**Float outstanding should track cash received.** That is the whole reconciliation. Float
outstanding is credit you have issued and the agent has not yet sold, so the sum of float you
have issued should never exceed the sum of cash you have actually taken in. If it drifts up
while your bank statement does not, somebody has been issued float they did not pay for. Check
this on a fixed rhythm, not when you happen to think of it.

**The one real abuse vector is an agent cycling float through accounts they control.** Agent
deposits are **fully bonus-eligible**. That is a deliberate product decision, and it means an
agent holding 10,000 of float can credit it to player accounts they own, collect the deposit
bonus on every one of those credits, and cash out the bonus without a single real player
having walked up to the counter. The float itself comes back to them; the bonus is pure
leakage.

The countermeasures actually in place are:

- **`agent_deposit_min`** - stops the pattern of many tiny deposits, which is what you get when
  someone is maximising bonus events rather than serving customers.
- **`agent_deposit_max`** - caps any single credit.
- **Instant suspension** - an agent can be suspended immediately, which stops them crediting
  anyone while you work out what happened.

There is deliberately **no daily cap**. A busy, honest agent on a good day looks exactly like a
suspicious one to a volume threshold, and a cap that fires on the honest agent costs you real
deposits. The controls are per-deposit shape plus a fast kill switch, not a volume ceiling.

What that means for you: **volume is not the signal, shape is.** Look for

- deposits clustering at a single amount, especially right at `agent_deposit_min`,
- credits going repeatedly to a small set of player accounts,
- players who are credited and then never play, or who withdraw almost immediately,
- an agent burning through float far faster than they buy it back.

**Suspend first, reconcile after.** Suspension is instant and reversible. Float that has
already been credited, bonused, and withdrawn is neither.
