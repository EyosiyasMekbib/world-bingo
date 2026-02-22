# ============================================================
# World Bingo API — Multi-stage Dockerfile
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/game-logic/package.json ./packages/game-logic/

# Install all dependencies (including devDeps needed for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared-types ./packages/shared-types
COPY packages/game-logic   ./packages/game-logic
COPY apps/api              ./apps/api

# Build shared packages first
RUN pnpm --filter @world-bingo/shared-types build 2>/dev/null || true
RUN pnpm --filter @world-bingo/game-logic build 2>/dev/null || true

# Build the API
WORKDIR /app/apps/api
RUN pnpm run build

# Generate Prisma client for production
RUN pnpm exec prisma generate

# ---- Stage 2: Production runner ----
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/game-logic/package.json ./packages/game-logic/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output and prisma from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

RUN chown -R appuser:appgroup /app
USER appuser

WORKDIR /app/apps/api

EXPOSE 8080

# Run migrations then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
