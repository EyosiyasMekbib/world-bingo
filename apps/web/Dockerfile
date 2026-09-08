# ============================================================
# World Bingo Web App — Multi-stage Dockerfile
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/game-logic/package.json ./packages/game-logic/
COPY packages/ui/package.json ./packages/ui/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types ./packages/shared-types
COPY packages/game-logic   ./packages/game-logic
COPY packages/ui           ./packages/ui
COPY apps/web              ./apps/web

# Build shared packages
RUN pnpm --filter @world-bingo/shared-types build 2>/dev/null || true
RUN pnpm --filter @world-bingo/game-logic build

# Build Nuxt app
# NUXT_API_PROXY_TARGET is baked into the static routeRules proxies at build time.
# Defaults to http://api:8080; spokes pass a suffixed host (e.g. http://api-betbawa:8080).
ARG NUXT_API_PROXY_TARGET=http://api:8080
ENV NUXT_API_PROXY_TARGET=$NUXT_API_PROXY_TARGET
# PostHog ingest proxy targets are baked into routeRules too. EU Cloud defaults;
# override both only for a US-region project.
ARG NUXT_POSTHOG_PROXY_TARGET=https://eu.i.posthog.com
ENV NUXT_POSTHOG_PROXY_TARGET=$NUXT_POSTHOG_PROXY_TARGET
ARG NUXT_POSTHOG_ASSETS_PROXY_TARGET=https://eu-assets.i.posthog.com
ENV NUXT_POSTHOG_ASSETS_PROXY_TARGET=$NUXT_POSTHOG_ASSETS_PROXY_TARGET
WORKDIR /app/apps/web

# PostHog error tracking: the nitro:build:before hook in nuxt.config.ts runs
# scripts/posthog-sourcemaps.sh (inject chunk ids, upload the hidden client
# source maps, strip every .map) DURING this build, before Nitro copies and
# measures the client output — never as a step after `nuxt build` runs. See
# the comment on that hook: doing this post-build once shipped truncated JS
# to production. Gated on POSTHOG_CLI_API_KEY (BuildKit secret, never a build
# arg) + POSTHOG_CLI_PROJECT_ID; never fails the build.
ARG POSTHOG_CLI_PROJECT_ID=
ARG POSTHOG_CLI_HOST=https://eu.posthog.com
ARG POSTHOG_CLI_VERSION=0.18.1
RUN --mount=type=secret,id=POSTHOG_CLI_API_KEY \
    POSTHOG_CLI_PROJECT_ID="$POSTHOG_CLI_PROJECT_ID" \
    POSTHOG_CLI_HOST="$POSTHOG_CLI_HOST" \
    POSTHOG_CLI_VERSION="$POSTHOG_CLI_VERSION" \
    pnpm run build

# ---- Stage 2: Production runner ----
FROM node:22-alpine AS runner

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/apps/web/.output ./.output

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", ".output/server/index.mjs"]
