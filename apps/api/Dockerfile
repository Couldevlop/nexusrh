# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── ÉTAPE 1 : BUILDER (Compilation) ───────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# Installation de pnpm
RUN npm install -g pnpm@9.4.0

# 1. Copie des fichiers de configuration racine
# On en a besoin pour que pnpm comprenne le monorepo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig*.json ./

# 2. Copie du code source nécessaire
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

# 3. Installation de TOUTES les dépendances (y compris tsc)
RUN pnpm install --frozen-lockfile

# 4. GÉNÉRATION DU DIST (L'étape qui te manquait)
# Cette commande crée le dossier apps/api/dist à l'intérieur de l'image builder
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrhci/api run build

# ── ÉTAPE 2 : RUNNER (Exécution) ──────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Sécurité : utilisateur non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# 5. RÉCUPÉRATION DU DIST DEPUIS LE BUILDER
# On ne copie plus depuis la machine locale, mais depuis l'étape 'builder'
COPY --from=builder --chown=1001:1001 /app/apps/api/dist ./dist
COPY --from=builder --chown=1001:1001 /app/apps/api/package.json ./package.json

# 6. Installation des dépendances de prod uniquement pour que l'image soit légère
RUN npm install -g pnpm@9.4.0
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
RUN pnpm install --prod --frozen-lockfile

USER 1001
EXPOSE 4001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["node", "dist/index.js"]