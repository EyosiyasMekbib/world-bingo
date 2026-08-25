-- Adds the active theme id to the singleton brand config.
--
-- NOT NULL with a DEFAULT of 'arada' so every existing row backfills to the
-- current look. arada's default palette is byte-identical to DEFAULT_BRAND.tokens,
-- so a deployment that takes this migration renders exactly as it did before.

-- AlterTable
ALTER TABLE "brand_settings" ADD COLUMN     "themeId" TEXT NOT NULL DEFAULT 'arada';
