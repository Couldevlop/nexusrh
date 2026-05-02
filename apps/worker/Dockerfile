# syntax=docker/dockerfile:1
# ── NexusRH Worker — Dockerfile multi-arch (amd64 + arm64) ──────────────────
ARG NODE_VERSION=20

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@9

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter @nexusrh/worker...

FROM base AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY . .
EXPOSE 4001
CMD ["pnpm", "--filter", "@nexusrh/worker", "run", "dev"]

FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @nexusrh/worker run build

FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app
RUN apk add --no-cache postgresql-client && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
ENV NODE_ENV=production
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
USER nodejs
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
CMD ["node", "dist/index.js"]
