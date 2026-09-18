# Bonus and cashback UI redesign — mockups

Nine artboards proposing the bonus and cashback experience, drawn as static
mockups before any implementation. Published as a pan/zoom design canvas:
**https://claude.ai/artifact/2E9rya7ssw3DGgEa45kfqq**

These are design sources, not application code. Nothing here is imported or
built by the apps.

## What each file is

Every `.dc.html` is one artboard. `canvas.json` lays them out on two pages and
carries the review notes.

| File | Screen |
|------|--------|
| `PromoCards.dc.html` | The promo tile: five across, generated vs artwork, phone, expiry bar |
| `LobbyPromo.dc.html` | Lobby hero, expiry bar and the five-across offer carousel |
| `Main.dc.html` | Wallet — the My Bonuses hub |
| `Promotions.dc.html` | Promotions page — two-up grid of tiles with progress |
| `BonusMoments.dc.html` | Bonus arrival toast, first-deposit modal, notification inbox |
| `AdminPromotions.dc.html` | Admin — one Promotions list for every offer type |
| `AdminPromoArtwork.dc.html` | Admin — artwork upload, requirements and live preview |
| `AdminPromoDetail.dc.html` | Admin — promotion detail, budget, live qualification preview |
| `AdminPlayerBonuses.dc.html` | Admin — player detail Bonuses tab |

## The promo tile

**225 x 675** — the width is exactly a third of the height. Five fit a 1192px
row with 16px gaps and three pixels to spare. One tile, the same shape whether
or not artwork exists, which is what lets the two modes mix freely in a row.

- **Head, 3:8 (600px).** Either an uploaded portrait image, or a generated
  composition centred like a poster: a tone-on-tone diamond lattice over a top
  glow, a seal, a kicker, then the amount in Oswald under one gold gradient
  clipped to the text, its bevel and glow from two drop shadows.
- **Foot, 75px.** The player's own progress, or the single action worth a
  button. Always system-drawn, so uploading artwork never costs personalisation.

One metal for the whole family rather than a different accent per offer.
Variety is meant to come from the artwork, not from five competing colours.

The row is a carousel: arrows beside the section link, dots underneath, more
offers on the next page. On phones the same tile drops to 168 wide and shows
two and a peek; the promotions page uses it in a two-up grid at 165.

The expiry warning is not a tile. It is player state, so it sits above the
carousel as a full-width bar and is never artwork.

## Artwork upload

One portrait image per promotion at **3:8, 750 x 2000 or larger**, JPG, PNG or
WebP under 2 MB. The same file is used at every width, scaled and never
re-cropped, so there is no separate mobile asset. Anything that is not 3:8 is
refused rather than cropped: a crop on a portrait card eats the headline and
the admin never sees it happen. That mirrors the existing hero banner code,
which already refuses to draw anything over admin artwork.

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

## The scenario every screen shares

Every screen shows the same moment, so the figures cross-check. Monday
9 March 2026, 21:15 Africa/Addis_Ababa. Player `dawit_a` holds 1,190.00
withdrawable and 100.00 bonus in two lots of 50.00:

- **Daily 500 Bonus**, granted 00:20 today from Sunday's deposit approved after
  manual review, valid 24h, so it dies tonight. This is the urgent lot, and it
  also shows the real behaviour where the deposit's own date picks the bucket
  while the approval instant anchors the expiry.
- **Weekend Cashback**, paid 00:15 today when last week's period closed, valid
  7 days.

In flight: 320 of 500 ETB lost this week, and 200 of 500 ETB deposited today.
Neither has paid out.

Two behaviour changes are baked into the numbers and are deliberate:

- **Cashback pays at period close**, not at the first hourly run that sees the
  threshold crossed. Paying on first crossing freezes the payout at whatever
  the loss happened to be that hour, and pays players who then win it back.
- **The VIP-scoped weekly rule never appears on a player surface.** A
  segment-targeted rule can only pay its frozen cohort, so advertising it to
  everyone is worse than not advertising it. It shows in the admin list with
  its segment badge and nowhere else.

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
- Promotions have nowhere to store card artwork. Cashback promotions and bonus
  rules each need an artwork field plus alt text, and the welcome bonus is a
  site setting today so it has nothing to hang an image on. Upload storage
  already exists for hero banners and can be reused.
- Cashback runs hourly on the window containing "now", so period-close payout
  and the projected-payout preview both need the scheduling change above.
- Balance adjustment sits in the clerk scope with no cap and no record of the
  actor. The player Bonuses tab assumes it has moved to admin and writes an
  audit row.

Sample figures throughout. Copy is drafted in English only and needs an Amharic
pass before build.

## Regenerating the canvas

The published page is assembled by the `design` skill's seeding helper from the
files in this directory, then published to the URL above. The assembled
output is a large generated bundle and is deliberately not committed — see
`.gitignore`.

Edit the artboards here, then re-seed and republish to the same URL.
