-- The deployment that moved from dash5 to winner still carried the Dashbet
-- name and its uploaded Dashbet logo, so the Winner theme rendered under the
-- old brand. Clearing logoUrl lets the theme's own logo
-- (apps/web/public/brands/winner/logo.png) show; an admin upload still wins.
--
-- Data only, and guarded on the old name so it touches that one row and
-- nothing an admin has since renamed.

UPDATE "brand_settings"
SET "displayName" = 'Winner', "shortName" = 'Winner', "logoUrl" = NULL
WHERE "themeId" = 'winner' AND "displayName" = 'Dashbet';
