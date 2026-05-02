# syntax=docker/dockerfile:1
# ── NexusRH Web — Dockerfile multi-arch (amd64 + arm64) ─────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/web:latest .
ARG NODE_VERSION=20

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

# ── Install dependencies ──────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# ── Development ───────────────────────────────────────────────────────────────
FROM base AS development
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
EXPOSE 3000
VOLUME ["/app/node_modules", "/app/apps/web/node_modules", "/app/packages/shared/node_modules"]
CMD ["pnpm", "--filter", "web", "run", "dev", "--host"]

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @nexusrh/shared build && \
    pnpm --filter web build

# ── Production (nginx alpine minimal) ─────────────────────────────────────────
FROM nginx:1.25-alpine AS production
RUN addgroup -g 1001 -S nginx-app && \
    adduser -S nginx-app -u 1001
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx-app:nginx-app /usr/share/nginx/html && \
    chown -R nginx-app:nginx-app /var/cache/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx-app:nginx-app /var/run/nginx.pid
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:80/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
