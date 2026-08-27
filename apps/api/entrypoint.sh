#!/bin/sh
set -eu

PRISMA_BIN="node_modules/.bin/prisma"
TSX_BIN="node_modules/.bin/tsx"
DEPLOY_LOG="/tmp/prisma-migrate-deploy.log"
STATUS_LOG="/tmp/prisma-migrate-status.log"

RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"
# Escape hatch for the schema-drift guard below. Booting knowingly-stale app
# code is a deliberate, temporary act; it must never be the silent default.
ALLOW_SCHEMA_DRIFT="${ALLOW_SCHEMA_DRIFT:-false}"
RUN_SEED="${RUN_SEED:-false}"
SEED_STRICT="${SEED_STRICT:-false}"
DB_MAX_RETRIES="${DB_MAX_RETRIES:-30}"
DB_RETRY_DELAY_SECS="${DB_RETRY_DELAY_SECS:-2}"
MIGRATION_ROLLBACK_ID="${MIGRATION_ROLLBACK_ID:-}"

# Is every migration in prisma/migrations recorded as applied?
#
# `migrate status` exits non-zero when anything is pending or failed, which is
# exactly the question worth asking before serving traffic. Output is captured
# and echoed rather than streamed so the failure path can inspect it.
assert_schema_current() {
	if "$PRISMA_BIN" migrate status >"$STATUS_LOG" 2>&1; then
		return 0
	fi
	cat "$STATUS_LOG"
	return 1
}

run_migrations() {
	echo "📦 Running pending migrations..."

	if [ -n "$MIGRATION_ROLLBACK_ID" ]; then
		echo "↩️  Marking migration as rolled back: $MIGRATION_ROLLBACK_ID"
		"$PRISMA_BIN" migrate resolve --rolled-back "$MIGRATION_ROLLBACK_ID" 2>/dev/null || true
	fi

	attempt=1
	while [ "$attempt" -le "$DB_MAX_RETRIES" ]; do
		if "$PRISMA_BIN" migrate deploy >"$DEPLOY_LOG" 2>&1; then
			cat "$DEPLOY_LOG"
			echo "✅ Migrations completed"
			return 0
		fi
		cat "$DEPLOY_LOG"

		# P3009 means a migration is recorded FAILED in _prisma_migrations, and
		# every migration behind it is blocked. Retrying returns the identical
		# error 30 times, so the loop only buries the cause under a minute of
		# noise — which is how one failed migration went unnoticed for two days
		# while four more queued up behind it. Fail now, and say what to do.
		if grep -q "P3009" "$DEPLOY_LOG"; then
			echo "❌ A previous migration is marked FAILED in _prisma_migrations."
			echo "   Nothing behind it can apply until it is resolved by hand:"
			echo "     1. Read the failure:  SELECT logs FROM _prisma_migrations WHERE finished_at IS NULL;"
			echo "     2. Check whether its objects actually exist in the database."
			echo "     3a. They do not exist:  prisma migrate resolve --rolled-back <migration_name>"
			echo "     3b. They all exist:     prisma migrate resolve --applied     <migration_name>"
			echo "   Then redeploy. Do NOT set RUN_MIGRATIONS=false to get past this."
			return 1
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

	# Skipping migrations is not the same as the schema being fine, and the
	# difference is invisible at boot: app code compiled against a newer schema
	# starts happily and then fails per-request, as a 500 on whichever endpoint
	# touches the missing column. That is how a deploy "succeeded", reported
	# healthy, and took deposits down on one brand while the other was fine.
	#
	# So: not applying migrations is allowed, but running against a schema that
	# does not match them is not — unless someone says so out loud.
	if [ "$ALLOW_SCHEMA_DRIFT" = "true" ]; then
		echo "⚠️  ALLOW_SCHEMA_DRIFT=true — not verifying schema state."
		echo "⚠️  Endpoints touching un-migrated columns will fail at runtime."
	elif assert_schema_current; then
		echo "✅ Schema matches the migration history"
	else
		echo "❌ Refusing to start: the database is behind prisma/migrations."
		echo "   This container would boot and then 500 on any endpoint that"
		echo "   touches a missing column, which is far harder to spot."
		echo "   Fix by applying them (RUN_MIGRATIONS=true, or run"
		echo "   'prisma migrate deploy' by hand), or set ALLOW_SCHEMA_DRIFT=true"
		echo "   to boot anyway and accept the runtime failures."
		exit 1
	fi
fi

if [ "$RUN_SEED" = "true" ]; then
	run_seed
else
	echo "⏭️  Skipping seed (RUN_SEED=false)"
fi

echo "🚀 Starting API server..."
if [ "${OTEL_ENABLED:-false}" = "true" ]; then
	echo "🔭 OpenTelemetry auto-instrumentation enabled"
	exec node --import @opentelemetry/auto-instrumentations-node/register dist/index.js
else
	exec node dist/index.js
fi
