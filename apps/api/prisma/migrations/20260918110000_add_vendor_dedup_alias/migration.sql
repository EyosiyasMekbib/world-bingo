-- Vendor de-dup alias for cross-provider lobby de-duplication.
--
-- The shadowing key is vendor + game name, but providers name the same studio
-- differently (Atlas-V's seeded catalog sits under a vendor named "Atlas-V";
-- Palace lists the same studio as "ATLAS V2"), so the two copies never shared
-- a group. "dedupAlias" on game_vendors overrides the vendor half of the key;
-- null falls back to the vendor name. Editable on the admin provider page.

ALTER TABLE "game_vendors" ADD COLUMN "dedupAlias" TEXT;

-- Pre-fill the one mismatch known at the time of writing: every vendor whose
-- normalized name is "atlasv" with an optional version suffix joins the
-- "atlasv" group, so Atlas-V's own copies win by priority from this deploy.
UPDATE "game_vendors"
SET "dedupAlias" = 'atlasv'
WHERE "dedupAlias" IS NULL
  AND regexp_replace(lower("name"), '[^a-z0-9]', '', 'g') ~ '^atlasv[0-9]*$';

-- Re-projection, identical to GameCatalogService.applyShadowing().
WITH ranked AS (
    SELECT g.id,
           ROW_NUMBER() OVER (
               PARTITION BY COALESCE(
                                NULLIF(regexp_replace(lower(v."dedupAlias"), '[^a-z0-9]', '', 'g'), ''),
                                regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g')
                            ),
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

UPDATE provider_games g
SET "shadowed" = false
FROM game_providers p, game_vendors v
WHERE p.id = g."providerId" AND v.id = g."vendorId"
  AND g."shadowed" = true
  AND (g."isActive" = false OR p.status <> 'ACTIVE' OR v."isActive" = false);
