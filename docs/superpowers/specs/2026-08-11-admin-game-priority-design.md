# Admin-managed game priority order

**Date:** 2026-08-11
**Branch:** `feat/admin-game-priority`
**Status:** approved design, ready for implementation planning

## Problem

Which casino games appear first in the player lobby is hard-coded in the frontend.
`apps/web/pages/index.vue` holds a 20-entry `FEATURED_GAMES` array and sorts the loaded
games client-side (`featuredRank()` / `sortFeatured()`), so:

- changing the order requires a code change and a web deploy;
- the pin only reorders games already fetched into the browser — the catalog is paginated
  server-side (60 per page), so a "featured" game sitting on page 3 never floats to the top;
- the order applies only to the ALL / TRENDING / POPULAR tabs, not to category tabs or search;
- `ProviderGame.sortOrder` exists in the schema but nothing writes it.

Admins need to set the priority order themselves, from the admin panel, without a deploy.

## Scope

In scope: ordering of **casino provider games** (`ProviderGame` — Palace, GASea, …).

Out of scope: bingo rooms (`Game` / `GameTemplate`) keep their current placement and
ordering; the category tab order stays hard-coded in the web app; no play-count-driven
automatic ranking.

## Decisions

| Question | Decision |
|---|---|
| What gets prioritized | Casino provider games |
| Priority model | One global ordered list; unpinned games keep today's fallback order |
| What a pin identifies | The **normalized game name**, across every provider |
| Where the order applies | Everywhere games are listed: lobby tabs, category tabs, search, admin catalog |
| Admin UI | New "Featured Games" page in the admin nav, under the Games group |
| Rollout | Seed today's 20 hard-coded names in their current order; delete the frontend constant |

Pinning by name (rather than by provider + game code) means one list covers every provider
that carries the same title, and a newly synced provider inherits the order automatically.
The trade-off — renames or name collisions can mis-pin — is acceptable because it is exactly
the matching the hard-coded list already uses.

## Data model

Source of truth is a small ordered table; `ProviderGame` carries a denormalized rank so the
database can do the ordering (and therefore pagination) itself.

```prisma
model FeaturedGame {
  id        String   @id @default(uuid())
  nameKey   String   @unique   // lower(gameName) with non-alphanumerics stripped
  label     String             // display name captured when pinned, e.g. "Aviator"
  position  Int                // 0-based rank; contiguous after every save
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([position])
  @@map("featured_games")
}
```

Added to `ProviderGame`:

```prisma
  featuredRank Int?    // projected from FeaturedGame.position; null = unpinned
  @@index([featuredRank])
```

Keeping the list in its own table means a pin survives a catalog re-sync and can name a game
that is not in the catalog yet; keeping `featuredRank` on the row means every existing query
gets the order with a one-line `orderBy` change.

`sortOrder` is left untouched: it stays the secondary key so any future per-provider ordering
still works.

## Ordering

Every provider-game query becomes:

```ts
orderBy: [
  { featuredRank: { sort: 'asc', nulls: 'last' } },
  { sortOrder: 'asc' },
  { gameName: 'asc' },
]
```

Call sites:

- `GameCatalogService.getGames` (`apps/api/src/services/game-catalog.service.ts:274`) — lobby grid and every category tab
- `GameCatalogService.searchCatalog` (`apps/api/src/services/game-catalog.service.ts:389`) — after `provider.name`, before `sortOrder`
- `GET /admin/providers/:code/games` (`apps/api/src/routes/admin/index.ts:397`) — so admins see the same order players see

Prisma 5.22 supports `nulls` ordering on optional scalars, so no raw SQL is needed for reads.

## Applying the list

`FeaturedGameService.apply()` projects the list onto `provider_games` in one transaction:

1. `UPDATE provider_games SET "featuredRank" = NULL WHERE "featuredRank" IS NOT NULL`
2. one `UPDATE … FROM (VALUES …)` that joins on the normalized name:

```sql
UPDATE provider_games g
SET "featuredRank" = v.rank
FROM (VALUES ($1::text, $2::int), …) AS v(key, rank)
WHERE regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = v.key
```

Normalization lives in one exported helper (`toNameKey`) used by the service, the seed, and
the admin UI, so the TypeScript and SQL forms cannot drift.

`apply()` runs:

- when an admin saves the list;
- at the end of `GameCatalogService.syncGames`, so games created by a sync get their rank.

After applying, the existing cache-bust path (`game-catalog.service.ts:193-195`: delete
`tp:games:<provider>:*` and `tp:categories:<provider>`) runs for every provider, so the lobby
reflects the change within one request instead of waiting out the 600 s TTL.

## API

Admin routes, mounted alongside the existing provider routes and behind the same guard:

- `GET /admin/featured-games` → `{ items: [{ nameKey, label, position, matches }] }`
  where `matches` is how many catalog rows the pin currently resolves to (0 renders a
  "not in catalog" badge — the pin is kept, not dropped).
- `PUT /admin/featured-games` with `{ items: [{ nameKey, label }] }` → replaces the whole
  list, `position` assigned from array index, then calls `apply()`.

Whole-list replacement (rather than per-item move/insert endpoints) makes the drag-and-drop
save idempotent and removes any reordering race between two admins.

The picker needs to search the catalog, so `GET /admin/providers/:code/games` gains an
optional `search` query param (case-insensitive `contains` on `gameName`), mirroring the
player-facing `getGames` filter.

## Admin UI

New page `apps/admin/pages/featured-games.vue`, plus a nav entry in
`apps/admin/layouts/default.vue` in the Games group (after "Game Templates").

- provider selector (defaults to the first active provider) + search box over the catalog;
- clicking a result appends it to the list; duplicates are rejected by `nameKey`;
- the list is drag-reorderable, each row shows the label, thumbnail, its resolved match count,
  and a remove button;
- inactive or unmatched pins are flagged but allowed — hiding a game stays the job of the
  existing `isActive` toggle;
- one Save button issues the `PUT`; the page reloads the list from the response.

`apps/admin/composables/useAdminApi.ts` gains `getFeaturedGames()` and
`saveFeaturedGames(items)`, and `getProviderGames` gains the `search` param.

## Web app

`apps/web/pages/index.vue`: delete `FEATURED_GAMES`, `featuredRank()` and `sortFeatured()`
(lines 285-318) and the three `sortFeatured(...)` calls in `gridGames`. Grids render the
order the API returns. Nothing else in the lobby changes: bingo rooms still append after the
casino cards, `hasImage` filtering and vendor/favorites filters are untouched.

## Migration and seed

Hand-authored SQL migration (this repo's `prisma migrate dev` fails on the shadow database):

1. `CREATE TABLE featured_games` + unique index on `nameKey` + index on `position`;
2. `ALTER TABLE provider_games ADD COLUMN "featuredRank" INTEGER` + index;
3. seed the 20 current names in their current order with `ON CONFLICT (nameKey) DO NOTHING`;
4. run the same projection UPDATE as `apply()` so existing rows get their rank immediately.

Applied with `prisma migrate deploy`. The lobby therefore looks identical the moment the
migration lands, and the first admin save takes over from there.

## Testing

- unit: `toNameKey` normalization matches the SQL `regexp_replace` behaviour for the seeded
  names (spaces, punctuation, casing, digits);
- unit: `apply()` assigns contiguous ranks in list order, nulls previously-ranked rows, and
  ranks every provider's copy of a matched name;
- API: `PUT /admin/featured-games` replaces the list, reindexes `position`, and rejects
  duplicate `nameKey`s; `GET` returns items in `position` order with match counts;
- API: `getGames` returns pinned games first across a page boundary (the bug this fixes);
- `pnpm typecheck` and `pnpm build` are the trusted gate — the api vitest suite is
  order-dependent and flaky in this repo, so failure counts there are not evidence on their own.

## Risks

- **Name matching.** A vendor renaming "Chicken Road" to "Chicken Road X" silently unpins it.
  Mitigated by the match count shown per pin in the admin UI.
- **Rank projection is a full-table UPDATE.** Only runs on admin save and after a sync, both
  infrequent; the catalog is in the thousands of rows.
- **Cache.** Missing a bust would leave a stale lobby for up to 10 minutes; the bust reuses
  the path the sync already uses.
