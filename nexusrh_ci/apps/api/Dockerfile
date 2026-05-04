# ── pnpmstore: overridden in CI via --build-contexts pnpmstore=<pnpm-store-v3> ────────────
FROM node:20-alpine AS pnpmstore

# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

# Populate pnpm store from pre-fetched packages (CI). No-op on local builds.
RUN mkdir -p /root/.local/share/pnpm/store/v3
RUN --mount=from=pnpmstore,target=/mnt/pnpmstore \
    [ -d /mnt/pnpmstore/files ] && cp -a /mnt/pnpmstore/. /root/.local/share/pnpm/store/v3/ || true

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && pnpm config set fetch-retry-mintimeout 5000 --global \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline

COPY tsconfig.base.json ./
COPY apps/api/ ./apps/api/

WORKDIR /build/apps/api
RUN /build/node_modules/.bin/tsc -p tsconfig.build.json

# ── Stage 2 : runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=builder --chown=1001:1001 /build/apps/api/dist ./dist
COPY --from=builder --chown=1001:1001 /build/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /build/apps/api/package.json ./package.json

USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["node", "dist/index.js"]
