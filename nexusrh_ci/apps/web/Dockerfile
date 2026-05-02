# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-timeout 600000 --global \
 && pnpm config set node-linker hoisted --global \
 && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/web/ ./apps/web/

RUN pnpm --filter @nexusrhci/web run build

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
