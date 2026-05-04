# syntax=docker/dockerfile:1.7
# Pattern officiel pnpm + Docker : https://pnpm.io/docker

FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

FROM base AS prod-deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/

RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline \
    --filter @nexusrhci/worker

FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/

RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline \
    --filter @nexusrhci/worker

COPY tsconfig.base.json ./
COPY apps/worker/ ./apps/worker/

RUN node_modules/.bin/tsc -p apps/worker/tsconfig.json

FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=build     --chown=1001:1001 /app/apps/worker/dist   ./dist
COPY --from=prod-deps --chown=1001:1001 /app/node_modules       ./node_modules
COPY --from=prod-deps --chown=1001:1001 /app/apps/worker/package.json ./package.json

USER 1001
CMD ["node", "dist/index.js"]
