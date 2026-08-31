# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# ── deploy : arbre de production EXACT ───────────────────────────────────────
# `pnpm install --prod --filter` ne suffisait pas : en linker hoisted il
# materialisait tout le graphe du workspace, si bien que l'image d'execution
# embarquait react, tailwindcss, tsx et surtout le binaire Go d'esbuild — un
# outil de BUILD, porteur a lui seul d'un CVE critique et de 21 CVE hautes.
# `pnpm deploy` construit l'arbre reellement necessaire et y injecte
# @nexusrhci/shared : plus besoin de recopier le paquet a la main.
#
# PAS de `node-linker=hoisted` ici : en mode hoisted, `pnpm deploy` n'injecte
# pas les paquets du workspace et @nexusrhci/shared disparait de l'arbre livre
# (le worker demarre puis meurt au premier import : garde SSRF, dechiffrement
# des secrets badgeuse).
FROM base AS deploy
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/dist ./apps/worker/dist
COPY packages/shared/dist ./packages/shared/dist
RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline \
    --filter @nexusrhci/worker \
 && pnpm deploy --filter @nexusrhci/worker --prod /out

FROM node:20-alpine AS runner
WORKDIR /app
# Surface d'attaque de l'image de base :
#  - `apk upgrade` applique les correctifs Alpine (libcrypto3/libssl3...) publies
#    depuis la construction du tag node:20-alpine ;
#  - le CLI npm n'est JAMAIS utilise a l'execution (on installe avec pnpm au
#    build) mais il embarque ses propres dependances figees — tar, minimatch,
#    glob, cross-spawn... — qui pesent une vingtaine de CVE hautes. On le retire.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
COPY --chown=1001:1001 apps/worker/dist           ./dist
COPY --from=deploy --chown=1001:1001 /out/node_modules ./node_modules
COPY --chown=1001:1001 apps/worker/package.json   ./package.json
USER 1001
CMD ["node", "dist/index.js"]
