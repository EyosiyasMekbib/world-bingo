#!/bin/sh
set -e

echo "🔧 Resolving stuck migrations (if any)..."
# Resolve previously stuck migrations gracefully
node_modules/.bin/prisma migrate resolve --applied 20260404101151_cashback_threshold_based 2>/dev/null || echo "⚠️  Migration already resolved or not found"
node_modules/.bin/prisma migrate resolve --rolled-back 20260411000000_unique_payment_transaction_id 2>/dev/null || echo "⚠️  Migration already resolved or not found"

echo "📦 Running pending migrations..."
node_modules/.bin/prisma migrate deploy

echo "🌱 Seeding database (if needed)..."
(node_modules/.bin/tsx prisma/seed.ts || echo "⏭️  Seed skipped")

echo "🚀 Starting API server..."
exec node dist/index.js
