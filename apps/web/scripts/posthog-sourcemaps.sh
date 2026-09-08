#!/bin/sh
# posthog-sourcemaps.sh — runs after `nuxt build` in the web Docker builder.
#
#   1. With a PostHog personal API key (env POSTHOG_CLI_API_KEY, or the
#      BuildKit secret file) and a project id: inject a chunk id into every
#      client chunk and upload the hidden source maps to PostHog error
#      tracking, so stack traces symbolicate.
#   2. Always: delete every .map under <dir>, so no map ships.
#
# Never fails the build. A PostHog outage or a bad token must not block a
# deploy; it prints a loud line instead. Grep a build log for
# "posthog-sourcemaps:" to see what happened.
#
# Usage: posthog-sourcemaps.sh <dir>          dir = .output/public/_nuxt
# Env:   POSTHOG_CLI_API_KEY       personal API key, scope error_tracking:write
#        POSTHOG_CLI_PROJECT_ID    numeric project id (from the PostHog URL)
#        POSTHOG_CLI_HOST          default https://eu.posthog.com
#        POSTHOG_CLI_VERSION       @posthog/cli version, default 0.18.1
#        POSTHOG_CLI_SECRET_FILE   default /run/secrets/POSTHOG_CLI_API_KEY
#        POSTHOG_CLI_BIN           override the CLI command (tests use a stub)
set -u

log() { echo "posthog-sourcemaps: $*"; }

DIR="${1:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "posthog-sourcemaps: usage: $0 <dir> (got '${DIR}')" >&2
  exit 2
fi

KEY="${POSTHOG_CLI_API_KEY:-}"
SECRET_FILE="${POSTHOG_CLI_SECRET_FILE:-/run/secrets/POSTHOG_CLI_API_KEY}"
if [ -z "$KEY" ] && [ -r "$SECRET_FILE" ]; then
  KEY="$(cat "$SECRET_FILE")"
fi
PROJECT_ID="${POSTHOG_CLI_PROJECT_ID:-}"
HOST="${POSTHOG_CLI_HOST:-https://eu.posthog.com}"
VERSION="${POSTHOG_CLI_VERSION:-0.18.1}"
# Fetched on demand so builds without a key pay nothing. The npm package picks
# a musl or glibc binary via detect-libc, so it runs in the Alpine builder.
CLI="${POSTHOG_CLI_BIN:-npx --yes @posthog/cli@${VERSION}}"

MAPS="$(find "$DIR" -type f -name '*.map' | wc -l | tr -d ' ')"

if [ -z "$KEY" ]; then
  log "no POSTHOG_CLI_API_KEY, skipping upload ($MAPS maps found)"
elif [ -z "$PROJECT_ID" ]; then
  log "POSTHOG_CLI_PROJECT_ID unset, skipping upload ($MAPS maps found)"
elif [ "$MAPS" = "0" ]; then
  log "no .map files under $DIR, nothing to upload (is sourcemap.client set?)"
else
  log "uploading $MAPS source maps to $HOST project $PROJECT_ID"
  # Both spellings: @posthog/cli 0.18 reads API_KEY/PROJECT_ID, older
  # releases read TOKEN/ENV_ID. `process` = inject, then upload.
  POSTHOG_CLI_API_KEY="$KEY" POSTHOG_CLI_TOKEN="$KEY" \
  POSTHOG_CLI_PROJECT_ID="$PROJECT_ID" POSTHOG_CLI_ENV_ID="$PROJECT_ID" \
    $CLI --host "$HOST" sourcemap process --directory "$DIR"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    log "upload done"
  else
    log "UPLOAD FAILED (exit $rc), build continues without symbolicated stacks" >&2
  fi
fi

# Strip maps whether or not the upload ran: they must never be served.
find "$DIR" -type f -name '*.map' -delete
log "removed $MAPS .map files from $DIR"
exit 0
