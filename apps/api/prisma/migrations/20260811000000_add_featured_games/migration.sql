-- Curated lobby priority.
--
-- featured_games is the ordered list an admin edits; provider_games."featuredRank"
-- is that order projected onto the catalog so the database can sort (and paginate)
-- by it. A pin matches on the normalized game name, which is why the projection
-- below strips case and punctuation the same way the TypeScript toNameKey() does.

CREATE TABLE "featured_games" (
    "id" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "featured_games_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "featured_games_nameKey_key" ON "featured_games"("nameKey");
CREATE INDEX "featured_games_position_idx" ON "featured_games"("position");

ALTER TABLE "provider_games" ADD COLUMN "featuredRank" INTEGER;
CREATE INDEX "provider_games_featuredRank_idx" ON "provider_games"("featuredRank");

-- Seed the order the web app previously hard-coded (apps/web/pages/index.vue),
-- so the lobby looks identical the moment this lands and the admin edits from there.
INSERT INTO "featured_games" ("id", "nameKey", "label", "position", "createdAt", "updatedAt") VALUES
    ('0f7c0f00-0000-4000-8000-000000000000', 'aviator',                     'Aviator',                       0, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000001', 'keno',                        'Keno',                          1, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000002', 'chickenroad',                 'Chicken Road',                  2, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000003', 'aviatrix',                    'Aviatrix',                      3, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000004', 'jetx',                        'JetX',                          4, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000005', 'chickenroad2',                'Chicken Road 2',                5, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000006', 'plinko',                      'Plinko',                        6, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000007', 'crashkick',                   'Crash Kick',                    7, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000008', 'chicknroad2',                 'Chick''n Road 2',               8, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000009', 'chicknroad',                  'Chick''n Road',                 9, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000a', 'flyx',                        'FlyX',                         10, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000b', 'flyxcashturbo',               'FlyX Cash Turbo',              11, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000c', 'plinkopop',                   'Plinko Pop',                   12, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000d', 'minepop',                     'Mine Pop',                     13, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000e', 'dicepop',                     'Dice Pop',                     14, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-00000000000f', 'bigbuttonbash',               'Big Button Bash',              15, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000010', 'soccerstriker',               'Soccer Striker',               16, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000011', 'theincredibleballoonmachine', 'The Incredible Balloon Machine', 17, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000012', 'fruitblast',                  'Fruit Blast',                  18, NOW(), NOW()),
    ('0f7c0f00-0000-4000-8000-000000000013', 'bg25plinko',                  'BG25 Plinko',                  19, NOW(), NOW())
ON CONFLICT ("nameKey") DO NOTHING;

-- Project the seeded list onto the existing catalog.
UPDATE "provider_games" g
SET "featuredRank" = f."position"
FROM "featured_games" f
WHERE regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = f."nameKey";
