# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── ÉTAPE 1 : COMPILATION (On crée le dist ici)
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9.4.0

# On copie les fichiers de configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Installation complète
RUN pnpm install --frozen-lockfile

# Copie du code source
COPY . .

# On génère le dossier dist
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrhci/api run build

# ── ÉTAPE 2 : RUNNER (L'image finale)
FROM node:${NODE_VERSION}-alpine AS final_runner
WORKDIR /app

# On crée l'utilisateur
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# ON RÉCUPÈRE LE DIST DEPUIS L'ÉTAPE BUILDER
# C'est cette ligne qui corrige l'erreur "not found"
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json

# On installe les outils pour le runner
RUN npm install -g pnpm@9.4.0
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
RUN pnpm install --prod --frozen-lockfile

USER 1001
EXPOSE 4001
CMD ["node", "dist/index.js"]