-- The 'dash5' theme id is retired in favour of 'winner'.
--
-- Data only. resolveTheme() falls back to arada for an id it does not know, so
-- a deployment still saved on 'dash5' would silently drop to the arada look on
-- the next boot instead of picking up its replacement.
--
-- Colour overrides are cleared with it: they were picked against the dash5
-- palette, and BrandService.updateBrand discards overrides on a theme switch
-- for the same reason.

UPDATE "brand_settings"
SET "themeId" = 'winner', "tokens" = '{}'::jsonb
WHERE "themeId" = 'dash5';
