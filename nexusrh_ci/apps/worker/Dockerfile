# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
# @nexusrhci/shared est une dependance workspace : son manifeste doit etre
# present pour que pnpm resolve le lien, sinon --frozen-lockfile echoue.
COPY packages/shared/package.json ./packages/shared/
RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)
RUN printf 'node-linker=hoisted\n' > .npmrc \
 && pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline \
    --filter @nexusrhci/worker

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
COPY --chown=1001:1001 apps/worker/dist           ./dist
COPY --from=prod-deps --chown=1001:1001 /app/node_modules ./node_modules
COPY --chown=1001:1001 apps/worker/package.json   ./package.json
# @nexusrhci/shared : pnpm le pose en lien symbolique dans
# apps/worker/node_modules, que cette image APLATIE (dist + node_modules a la
# racine) ne consulte jamais. On copie donc le paquet REEL la ou Node le
# cherche. Sans ces deux lignes, le worker meurt au premier import du paquet
# partage (garde SSRF, dechiffrement des secrets badgeuse).
COPY --chown=1001:1001 packages/shared/package.json ./node_modules/@nexusrhci/shared/package.json
COPY --chown=1001:1001 packages/shared/dist         ./node_modules/@nexusrhci/shared/dist
USER 1001
CMD ["node", "dist/index.js"]
