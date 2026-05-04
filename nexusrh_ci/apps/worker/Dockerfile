# ── pnpmstore: overridden in CI via --build-contexts pnpmstore=<pnpm-store-v3> ────────────
FROM node:20-alpine AS pnpmstore

# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/

# Populate pnpm store from pre-fetched packages (CI). No-op on local builds.
RUN mkdir -p /root/.local/share/pnpm/store/v3
RUN --mount=from=pnpmstore,target=/mnt/pnpmstore \
    [ -d /mnt/pnpmstore/files ] && cp -a /mnt/pnpmstore/. /root/.local/share/pnpm/store/v3/ || true

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && pnpm config set fetch-retry-mintimeout 5000 --global \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline

COPY tsconfig.base.json ./
COPY apps/worker/ ./apps/worker/

WORKDIR /build/apps/worker
RUN /build/node_modules/.bin/tsc -p tsconfig.json

# ── Stage 2 : runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=builder --chown=1001:1001 /build/apps/worker/dist ./dist
COPY --from=builder --chown=1001:1001 /build/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /build/apps/worker/package.json ./package.json

USER 1001

CMD ["node", "dist/index.js"]
