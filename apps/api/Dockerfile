# ============================================================
# World Bingo API — Multi-stage Dockerfile
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/game-logic/package.json ./packages/game-logic/

# Install all dependencies (including devDeps needed for build)
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared-types ./packages/shared-types
COPY packages/game-logic   ./packages/game-logic
COPY apps/api              ./apps/api

# Build shared packages first
RUN pnpm --filter @world-bingo/shared-types build 2>/dev/null || true
RUN pnpm --filter @world-bingo/game-logic build 2>/dev/null || true

# Generate Prisma client before building (needed for type imports)
# Cache the prisma engine binaries to avoid re-downloading on each build
WORKDIR /app/apps/api
RUN --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh \
    pnpm exec prisma generate

# Build the API
RUN pnpm run build

# ---- Stage 2: Production runner ----
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy all node_modules from builder (includes prisma CLI + generated client)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/game-logic/package.json ./packages/game-logic/

# Copy compiled output and prisma schema from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

RUN chown -R appuser:appgroup /app
USER appuser

WORKDIR /app/apps/api

EXPOSE 8080

# Run migrations then start server
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
