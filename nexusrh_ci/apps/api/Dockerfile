# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# prod-deps : pnpm install --prod depuis le store pré-chargé par le runner
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
# @nexusrhci/shared est une dépendance workspace : son manifeste doit être
# présent pour que pnpm résolve le lien, sinon --frozen-lockfile échoue.
COPY packages/shared/package.json ./packages/shared/
RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)
RUN printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline \
    --filter @nexusrhci/api

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
# dist/ compilé sur le runner (plus de tsc dans Docker)
COPY --chown=1001:1001 apps/api/dist           ./dist
COPY --chown=1001:1001 apps/api/src/assets     ./dist/assets
COPY --from=prod-deps --chown=1001:1001 /app/node_modules ./node_modules
COPY --chown=1001:1001 apps/api/package.json   ./package.json
# @nexusrhci/shared : pnpm le pose en lien symbolique dans
# apps/api/node_modules, que cette image APLATIE (dist + node_modules à la
# racine) ne consulte jamais. On copie donc le paquet RÉEL là où Node le
# cherche. Sans ces deux lignes, l'API démarre puis meurt sur le premier
# import du paquet partagé.
COPY --chown=1001:1001 packages/shared/package.json ./node_modules/@nexusrhci/shared/package.json
COPY --chown=1001:1001 packages/shared/dist         ./node_modules/@nexusrhci/shared/dist
USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1
CMD ["node", "dist/index.js"]
