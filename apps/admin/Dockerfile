# ============================================================
# World Bingo Admin Dashboard — Multi-stage Dockerfile
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/admin/package.json ./apps/admin/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/ui/package.json ./packages/ui/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types ./packages/shared-types
COPY packages/ui           ./packages/ui
COPY apps/admin            ./apps/admin

# Build shared packages
RUN pnpm --filter @world-bingo/shared-types build 2>/dev/null || true

# Build Nuxt admin app
# NUXT_API_PROXY_TARGET is baked into the static routeRules proxies at build time.
# Defaults to http://api:8080; spokes pass a suffixed host (e.g. http://api-betbawa:8080).
ARG NUXT_API_PROXY_TARGET=http://api:8080
ENV NUXT_API_PROXY_TARGET=$NUXT_API_PROXY_TARGET
WORKDIR /app/apps/admin
RUN pnpm run build

# ---- Stage 2: Production runner ----
FROM node:22-alpine AS runner

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/apps/admin/.output ./.output

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

ENV HOST=0.0.0.0
ENV PORT=3001
ENV NODE_ENV=production

CMD ["node", ".output/server/index.mjs"]
