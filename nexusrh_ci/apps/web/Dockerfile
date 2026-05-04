# ── pnpmstore: overridden in CI via --build-contexts pnpmstore=<pnpm-store-v3> ────────────
FROM node:20-alpine AS pnpmstore

# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

# Populate pnpm store from pre-fetched packages (CI). No-op on local builds.
RUN mkdir -p /root/.local/share/pnpm/store/v3
RUN --mount=from=pnpmstore,target=/mnt/pnpmstore \
    [ -d /mnt/pnpmstore/files ] && cp -a /mnt/pnpmstore/. /root/.local/share/pnpm/store/v3/ || true

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && pnpm config set fetch-retry-mintimeout 5000 --global \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline

COPY tsconfig.base.json ./
COPY apps/web/ ./apps/web/

WORKDIR /build/apps/web
RUN /build/node_modules/.bin/vite build

# ── Stage 2 : runner ─────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

COPY --from=builder /build/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

RUN chown -R 101:101 /usr/share/nginx/html \
 && chown -R 101:101 /var/cache/nginx \
 && chown -R 101:101 /var/log/nginx \
 && touch /var/run/nginx.pid \
 && chown 101:101 /var/run/nginx.pid

USER 101
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
