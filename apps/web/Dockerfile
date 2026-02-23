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
WORKDIR /app/apps/web
RUN pnpm run build

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
