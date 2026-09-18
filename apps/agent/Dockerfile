# ============================================================
# World Bingo Agent Console — Multi-stage Dockerfile
# ============================================================

# ---- Stage 1: Builder ----
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/agent/package.json ./apps/agent/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/ui/package.json ./packages/ui/

# The store cache is shared by every image built on the host, and compose builds
# api, web, admin and agent at once. `sharing=locked` makes concurrent installs take
# turns; unlocked, one copied a native binary another was still writing, and the
# truncated rollup .node crashed the build with SIGBUS.
# A cache mount's id is not part of the layer cache key, so a corrupted install layer
# survives a store change. Bump INSTALL_CACHE_GENERATION to force a fresh install.
ARG INSTALL_CACHE_GENERATION=2
RUN --mount=type=cache,id=pnpm-store-v2,target=/root/.local/share/pnpm/store,sharing=locked \
    echo "install cache generation $INSTALL_CACHE_GENERATION" && pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types ./packages/shared-types
COPY packages/ui           ./packages/ui
COPY apps/agent            ./apps/agent

# Build shared packages
RUN pnpm --filter @world-bingo/shared-types build 2>/dev/null || true

# Build Nuxt agent app
# NUXT_API_PROXY_TARGET is baked into the static routeRules proxies at build time.
# Defaults to http://api:8080; spokes pass a suffixed host (e.g. http://api-betbawa:8080).
ARG NUXT_API_PROXY_TARGET=http://api:8080
ENV NUXT_API_PROXY_TARGET=$NUXT_API_PROXY_TARGET
WORKDIR /app/apps/agent
# Run nuxt directly so a failure reports its real exit status: when the build is
# killed by a signal, `pnpm run build` only prints "Command failed." with no code
# and nuxt prints nothing.
RUN node node_modules/nuxt/bin/nuxt.mjs build; code=$?; \
    if [ "$code" -ne 0 ]; then \
      echo "nuxt build exited with status $code (128+N = killed by signal N)"; \
      echo "node $(node -v) on $(uname -m)"; \
    fi; \
    exit $code

# ---- Stage 2: Production runner ----
FROM node:22-alpine AS runner

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/apps/agent/.output ./.output

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3003

ENV HOST=0.0.0.0
ENV PORT=3003
ENV NODE_ENV=production

CMD ["node", ".output/server/index.mjs"]
