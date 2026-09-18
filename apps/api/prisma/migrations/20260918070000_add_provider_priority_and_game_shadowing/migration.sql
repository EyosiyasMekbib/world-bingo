-- Provider priority for cross-provider lobby de-duplication.
--
-- "priority" on game_providers: when several ACTIVE providers carry the same
-- vendor + title, the lowest number wins (ties break on isPrimary, then the
-- oldest provider). The current primary provider is backfilled to 0 so the
-- existing search behaviour (primary first) carries over unchanged.
--
-- "shadowed" on provider_games: true when a higher-priority provider carries
-- the same title. Projected by GameCatalogService.applyShadowing() after every
-- catalog sync and every provider / game status change; the all-providers
-- lobby feed, categories and search filter on it, provider-scoped listings
-- do not.

ALTER TABLE "game_providers" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;
UPDATE "game_providers" SET "priority" = 0 WHERE "isPrimary" = true;

ALTER TABLE "provider_games" ADD COLUMN "shadowed" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "provider_games_isActive_shadowed_categoryCode_idx" ON "provider_games"("isActive", "shadowed", "categoryCode");

-- Initial projection, identical to applyShadowing() so the first deploy hides
-- duplicates without waiting for the next sync.
WITH ranked AS (
    SELECT g.id,
           ROW_NUMBER() OVER (
               PARTITION BY regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g'),
                            regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g')
               ORDER BY p.priority ASC, p."isPrimary" DESC, p."createdAt" ASC, g.id ASC
           ) AS rn
    FROM provider_games g
    JOIN game_providers p ON p.id = g."providerId"
    JOIN game_vendors v ON v.id = g."vendorId"
    WHERE g."isActive" = true AND p.status = 'ACTIVE' AND v."isActive" = true
)
UPDATE provider_games g
SET "shadowed" = (r.rn > 1)
FROM ranked r
WHERE r.id = g.id AND g."shadowed" IS DISTINCT FROM (r.rn > 1);
