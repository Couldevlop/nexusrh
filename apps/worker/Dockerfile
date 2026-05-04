# syntax=docker/dockerfile:1
# ── NexusRH Worker — Dockerfile multi-arch (amd64 + arm64) ──────────────────
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── 1. BASE (Partagée) ────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

# ── 2. DEPS (Installation des dépendances) ────────────────────
FROM base AS deps
# On copie les fichiers de configuration de la racine du monorepo (nexusrh_ci)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
# On copie les fichiers package.json des projets nécessaires
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# ── 3. BUILDER (Compilation) ──────────────────────────────────
FROM base AS builder
WORKDIR /app
# On récupère les node_modules de l'étape deps
COPY --from=deps /app ./ 
# On copie le reste du code source
COPY . . 

# Compilation
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrh/worker build

# ── 4. PRODUCTION (Image finale légère) ───────────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache postgresql-client && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Récupération des fichiers nécessaires depuis le builder
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# LA CORRECTION ICI : On s'assure que le chemin correspond à la structure du monorepo
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/dist ./dist

# Installation des dépendances de production uniquement
RUN pnpm install --prod --frozen-lockfile

USER nodejs

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

CMD ["node", "dist/index.js"]