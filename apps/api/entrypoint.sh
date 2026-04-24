#!/bin/sh
set -eu

PRISMA_BIN="node_modules/.bin/prisma"
TSX_BIN="node_modules/.bin/tsx"

RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"
RUN_SEED="${RUN_SEED:-false}"
SEED_STRICT="${SEED_STRICT:-false}"
DB_MAX_RETRIES="${DB_MAX_RETRIES:-30}"
DB_RETRY_DELAY_SECS="${DB_RETRY_DELAY_SECS:-2}"
MIGRATION_ROLLBACK_ID="${MIGRATION_ROLLBACK_ID:-}"

run_migrations() {
	echo "📦 Running pending migrations..."

	if [ -n "$MIGRATION_ROLLBACK_ID" ]; then
		echo "↩️  Marking migration as rolled back: $MIGRATION_ROLLBACK_ID"
		"$PRISMA_BIN" migrate resolve --rolled-back "$MIGRATION_ROLLBACK_ID" 2>/dev/null || true
	fi

	attempt=1
	while [ "$attempt" -le "$DB_MAX_RETRIES" ]; do
		if "$PRISMA_BIN" migrate deploy; then
			echo "✅ Migrations completed"
			return 0
		fi

		if [ "$attempt" -eq "$DB_MAX_RETRIES" ]; then
			echo "❌ Migration failed after $DB_MAX_RETRIES attempts"
			return 1
		fi

		echo "⚠️  Migration attempt $attempt failed, retrying in ${DB_RETRY_DELAY_SECS}s..."
		attempt=$((attempt + 1))
		sleep "$DB_RETRY_DELAY_SECS"
	done
}

run_seed() {
	echo "🌱 Running seed..."
	if "$TSX_BIN" prisma/seed.ts; then
		echo "✅ Seed completed"
		return 0
	fi

	if [ "$SEED_STRICT" = "true" ]; then
		echo "❌ Seed failed and SEED_STRICT=true"
		return 1
	fi

	echo "⏭️  Seed failed, continuing startup (SEED_STRICT=false)"
	return 0
}

if [ "$RUN_MIGRATIONS" = "true" ]; then
	run_migrations
else
	echo "⏭️  Skipping migrations (RUN_MIGRATIONS=false)"
fi

if [ "$RUN_SEED" = "true" ]; then
	run_seed
else
	echo "⏭️  Skipping seed (RUN_SEED=false)"
fi

echo "🚀 Starting API server..."
exec node dist/index.js
