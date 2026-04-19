#!/bin/sh
set -e

echo "📦 Running pending migrations..."
# Un-mark the cashback migration so it actually runs (it was previously skipped via --applied workaround)
node_modules/.bin/prisma migrate resolve --rolled-back 20260404101151_cashback_threshold_based 2>/dev/null || true
node_modules/.bin/prisma migrate deploy

echo "🌱 Seeding database (if needed)..."
(node_modules/.bin/tsx prisma/seed.ts || echo "⏭️  Seed skipped")

echo "🚀 Starting API server..."
exec node dist/index.js
