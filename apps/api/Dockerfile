# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
# syntax=docker/dockerfile:1
# syntax=docker/dockerfile:1
ARG NODE_VERSION=20

# ── Base ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

# ── Build ─────────────────────────────────────────────────────
FROM base AS builder
# Copie des fichiers de config racine (dont tsconfig.base.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
# Copie uniquement des dossiers nécessaires
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

RUN pnpm install --frozen-lockfile

# Compilation sécurisée
RUN pnpm --filter @nexusrh/shared build
RUN pnpm --filter @nexusrh/api run build

# ── Production ────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Sécurité OWASP : Utilisateur non-privilégié
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN npm install -g pnpm@9

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/api/dist ./dist

RUN pnpm install --prod --frozen-lockfile

USER nodejs
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]