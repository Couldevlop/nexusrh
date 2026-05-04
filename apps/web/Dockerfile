# syntax=docker/dockerfile:1
# ── NexusRH Web — Dockerfile multi-arch (amd64 + arm64) ─────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/web:latest .
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── Base ──────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui

# Installation complète pour le build
RUN pnpm install --frozen-lockfile

# Variables d'environnement pour le build Vite
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Build des dépendances internes avant l'application
RUN pnpm --filter @nexusrh/shared build && \
    pnpm --filter @nexusrh/ui build && \
    pnpm --filter web build

# ── Production ────────────────────────────────────────────────────────────────
FROM nginx:1.25-alpine AS production
# Sécurité OWASP : Ne pas tourner en root
RUN addgroup -g 1001 -S nginx-app && \
    adduser -S nginx-app -u 1001

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Gestion des droits pour l'utilisateur non-root
RUN chown -R nginx-app:nginx-app /usr/share/nginx/html && \
    chown -R nginx-app:nginx-app /var/cache/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx-app:nginx-app /var/run/nginx.pid

USER nginx-app
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]