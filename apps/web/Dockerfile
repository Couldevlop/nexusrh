# syntax=docker/dockerfile:1
# ── NexusRH Web — Dockerfile multi-arch (amd64 + arm64) ─────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/web:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── Étape 1 : Build ──────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9.1.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN pnpm --filter @nexusrh/shared build && \
    pnpm --filter @nexusrh/ui build && \
    pnpm --filter web build

# ── Étape 2 : Production (Nginx) ──────────────────────────────
FROM nginx:1.25-alpine AS production

# CORRECTION : On récupère le 'dist' du builder vers le dossier Nginx
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]