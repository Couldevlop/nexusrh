# syntax=docker/dockerfile:1.7
# Pattern officiel pnpm + Docker : https://pnpm.io/docker

# ── pnpmstore: surchargé en CI via --build-contexts pnpmstore=<path-to-store-v3> ─────────
FROM node:20-alpine AS pnpmstore

# ── Base commune ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# ── Stage deps : dépendances de production uniquement ─────────────────────────
FROM base AS prod-deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline

# ── Stage build : compilation TypeScript ──────────────────────────────────────
FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline

COPY tsconfig.base.json ./
COPY apps/api/ ./apps/api/

RUN node_modules/.bin/tsc -p apps/api/tsconfig.build.json

# ── Stage runner ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=build     --chown=1001:1001 /app/apps/api/dist   ./dist
COPY --from=prod-deps --chown=1001:1001 /app/node_modules    ./node_modules
COPY --from=prod-deps --chown=1001:1001 /app/apps/api/package.json ./package.json

USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["node", "dist/index.js"]
