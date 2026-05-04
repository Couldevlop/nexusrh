# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── Étape 1 : Base (Installation des outils) ──────────────────
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
# Installation de pnpm globalement
RUN npm install -g pnpm@9.1.0

# ── Étape 2 : Builder (Compilation du code) ───────────────────
FROM base AS builder

# Copie des fichiers de configuration à la racine de nexusrh_ci
# Cela inclut package.json, pnpm-workspace.yaml et tsconfig.base.json
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./

# Copie des dossiers nécessaires pour le build de l'API
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

# Installation des dépendances
RUN pnpm install --frozen-lockfile

# Compilation de la librairie partagée puis de l'API
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrh/api run build

# ── Étape 3 : Production (Image finale légère) ────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Sécurité OWASP : Création d'un utilisateur non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Installation de pnpm pour gérer les dépendances de prod
RUN npm install -g pnpm@9.1.0

# Copie des fichiers de structure
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# SOLUTION À TON ERREUR : On copie le dossier 'dist' compilé depuis l'étape builder
COPY --from=builder --chown=1001:1001 /app/apps/api/dist ./dist

# Installation uniquement des dépendances de production
RUN pnpm install --prod --frozen-lockfile

# On donne la propriété du dossier à l'utilisateur sécurisé
RUN chown -R nodejs:nodejs /app

USER nodejs
EXPOSE 4000

# Vérification de l'état de santé du conteneur
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

# Lancement de l'application
CMD ["node", "dist/index.js"]