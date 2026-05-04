# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── ÉTAPE 1 : BUILDER (Là où on génère le dossier 'dist')
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9

# 1. Copie des configs racine du dossier nexusrh_ci
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./

# 2. Copie des fichiers package.json pour optimiser le cache
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# 3. Installation des dépendances
RUN pnpm install --frozen-lockfile

# 4. Copie du reste du code source
COPY . .

# 5. Build obligatoire du shared avant l'API
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrh/api run build

# ── ÉTAPE 2 : RUNNER (L'image finale de production)
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Sécurité
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN npm install -g pnpm@9

# 6. ON RÉCUPÈRE LES FICHIERS DEPUIS L'ÉTAPE 'builder' (Indispensable)
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# ICI SE TROUVAIT L'ERREUR : Il faut ajouter --from=builder
# Et utiliser le chemin tel qu'il est construit dans l'étape builder
COPY --from=builder --chown=1001:1001 /app/apps/api/dist ./dist

# 7. Installation des dépendances de prod uniquement
RUN pnpm install --prod --frozen-lockfile

USER nodejs
EXPOSE 4000

CMD ["node", "dist/index.js"]