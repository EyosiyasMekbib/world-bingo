-- Admin-managed lobby hero banners.
--
-- Each row is a required desktop/mobile image pair. "position" is the display
-- order, kept contiguous (0..n-1) by the API on reorder and delete. The lobby
-- reads active rows in position order, hence the composite index.

CREATE TABLE "hero_banners" (
    "id" TEXT NOT NULL,
    "desktopImageUrl" TEXT NOT NULL,
    "mobileImageUrl" TEXT NOT NULL,
    "altText" TEXT NOT NULL DEFAULT '',
    "linkUrl" TEXT,
    "position" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hero_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hero_banners_isActive_position_idx" ON "hero_banners"("isActive", "position");
