# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── ÉTAPE 1 : COMPILER (On crée le dist ici)
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9.4.0

# On copie les fichiers de config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Installation complète pour le build
RUN pnpm install --frozen-lockfile

# Copie de TOUT le code source
COPY . .

# On lance la compilation
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrhci/api run build

# ── ÉTAPE 2 : PRODUCTION (Nom changé pour ignorer le cache runner)
FROM node:${NODE_VERSION}-alpine AS production_final
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# RÉCUPÉRATION DU DIST DEPUIS L'ÉTAPE 'builder'
# C'est la seule façon pour que GitHub Actions trouve le dossier
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json

# On réinstalle proprement pnpm pour les deps de prod
RUN npm install -g pnpm@9.4.0
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
RUN pnpm install --prod --frozen-lockfile

USER 1001
EXPOSE 4001
CMD ["node", "dist/index.js"]