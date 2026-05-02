# syntax=docker/dockerfile:1
# ── NexusRH API — Dockerfile multi-arch (amd64 + arm64) ────────────────────────
# Build : docker buildx build --platform linux/amd64,linux/arm64 -t nexusrh/api:latest .
ARG NODE_VERSION=20

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

# ── Install dependencies (cross-platform, Linux binaries) ────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter @nexusrh/api...

# ── Development (source mounted via volume, deps from image) ─────────────────
FROM base AS development
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/drizzle.config.ts ./apps/api/
COPY packages/shared ./packages/shared
EXPOSE 4000
VOLUME ["/app/node_modules", "/app/apps/api/node_modules", "/app/packages/shared/node_modules"]
CMD ["pnpm", "--filter", "@nexusrh/api", "run", "dev"]

# ── Build (target native pour l'image finale) ─────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @nexusrh/api run build

# ── Production (image minimale) ───────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
RUN apk add --no-cache postgresql-client && \
    npm install -g pnpm@9 && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
ENV NODE_ENV=production
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
USER nodejs
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/index.js"]
