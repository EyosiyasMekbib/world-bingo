# Bonus and cashback UI redesign — mockups

Seven proposed screens for the bonus and cashback experience, drawn as static
mockups before any implementation. Published as a pan/zoom design canvas:
**https://claude.ai/artifact/2E9rya7ssw3DGgEa45kfqq**

These are design sources, not application code. Nothing here is imported or
built by the apps.

## What each file is

Every `.dc.html` is one artboard. `canvas.json` lays them out on two pages and
carries the review notes.

| File | Screen |
|------|--------|
| `LobbyPromo.dc.html` | Lobby hero promo slide plus the new live-offer strip |
| `Main.dc.html` | Wallet — the My Bonuses hub |
| `Promotions.dc.html` | Promotions page with per-offer progress |
| `BonusMoments.dc.html` | Bonus arrival toast, first-deposit modal, notification inbox |
| `AdminPromotions.dc.html` | Admin — one Promotions list for every offer type |
| `AdminPromoDetail.dc.html` | Admin — promotion detail, budget, live qualification preview |
| `AdminPlayerBonuses.dc.html` | Admin — player detail Bonuses tab |

## Design values

Lifted from the live stylesheets rather than invented, so the mockups match
what ships:

- Player app: `packages/shared-types/src/brand.ts` (arada tokens), the scoped
  styles in `apps/web/pages/wallet.vue`, `apps/web/pages/promotions.vue` and
  `apps/web/pages/index.vue`. Oswald, Barlow Condensed and Inter.
- Admin app: `apps/admin/assets/css/main.css` tokens, table and status-tag
  rules, and the Nuxt UI card patterns used on the existing cashback and
  bonus-rules pages.

The brand colour is a per-artboard tweak, so the whole set can be flipped to
the dash5 palette to check the other deployment.

## What the mockups assume does not exist yet

- `BonusGrant` has no `source` column, so the source chips on four screens need
  that added first. Today a lot only knows its `ruleId`, which is null for
  cashback, welcome, campaign and admin grants.
- There is no per-player promotion-progress endpoint. The progress bars need
  one, reusing the net-loss and deposit-bucket queries the hourly cashback job
  and `DepositBonusService` already run.
- Cashback has no max payout per player and no period budget. Deposit rules
  have `maxReward`; cashback has nothing.
- The notification bell component exists but is not mounted in any layout.

Sample figures throughout. Copy is drafted in English only and needs an Amharic
pass before build.

## Regenerating the canvas

The published page is assembled by the `design` skill's seeding helper from the
files in this directory, then published to the URL above. The assembled
output is a large generated bundle and is deliberately not committed — see
`.gitignore`.

Edit the artboards here, then re-seed and republish to the same URL.
