# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── 1. BASE : Configuration de pnpm ───────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# ── 2. BUILDER : Compilation du code (tsc) ────────────────────
FROM base AS builder
WORKDIR /app

# On copie les fichiers de configuration racine
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig*.json ./
# On copie le code source nécessaire (API + Shared si besoin)
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

# Installation de TOUTES les dépendances (y compris devDeps comme tsc)
RUN pnpm install --frozen-lockfile

# Génération du dossier dist/ via le script build de ton package.json
RUN pnpm --filter @nexusrhci/api run build

# ── 3. PROD-DEPS : Installation propre des libs de prod ──────
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Installation uniquement des dépendances de production
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ── 4. RUNNER : L'image finale légère ─────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Sécurité : utilisateur non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# RÉCUPÉRATION DES FICHIERS DEPUIS LES ÉTAPES PRÉCÉDENTES
# On prend le dossier 'dist' généré par le builder
COPY --from=builder --chown=1001:1001 /app/apps/api/dist ./dist
# On prend les node_modules propres de prod-deps
COPY --from=prod-deps --chown=1001:1001 /app/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /app/apps/api/package.json ./package.json

USER 1001
EXPOSE 4001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["node", "dist/index.js"]