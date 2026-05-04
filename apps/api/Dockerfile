# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── Étape 1 : Build ──────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9.1.0

# Copie des fichiers de configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared ./packages/shared

# Installation et Build
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrh/api run build

# ── Étape 2 : Production ──────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN npm install -g pnpm@9.1.0

# On récupère les fichiers de structure
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# CORRECTION : On copie le 'dist' depuis l'étape 'builder'
COPY --from=builder --chown=1001:1001 /app/apps/api/dist ./dist

RUN pnpm install --prod --frozen-lockfile

USER nodejs
EXPOSE 4000
CMD ["node", "dist/index.js"]