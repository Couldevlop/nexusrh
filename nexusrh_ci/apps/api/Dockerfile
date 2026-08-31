# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# ── deploy : arbre de production EXACT ───────────────────────────────────────
# `pnpm install --prod --filter` ne suffisait pas : en linker hoisted il
# matérialisait tout le graphe du workspace, si bien que l'image d'exécution
# embarquait react, tailwindcss, tsx et surtout le binaire Go d'esbuild — un
# outil de BUILD, porteur à lui seul d'un CVE critique et de 21 CVE hautes.
# `pnpm deploy` construit l'arbre réellement nécessaire (220 Mo au lieu de 362)
# et y injecte @nexusrhci/shared : plus besoin de recopier le paquet à la main.
FROM base AS deploy
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/dist ./apps/api/dist
COPY packages/shared/dist ./packages/shared/dist
RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)
# PAS de `node-linker=hoisted` ici : en mode hoisted, `pnpm deploy` n'injecte
# pas les paquets du workspace et @nexusrhci/shared disparaît de l'arbre livré
# (l'API démarre puis meurt au premier import). Le linker par défaut produit
# un /out autonome, symlinks internes compris.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline \
    --filter @nexusrhci/api \
 && pnpm deploy --filter @nexusrhci/api --prod /out

FROM node:20-alpine AS runner
WORKDIR /app
# Surface d'attaque de l'image de base :
#  - `apk upgrade` applique les correctifs Alpine (libcrypto3/libssl3…) publiés
#    depuis la construction du tag node:20-alpine ;
#  - le CLI npm n'est JAMAIS utilisé à l'exécution (on installe avec pnpm au
#    build) mais il embarque ses propres dépendances figées — tar, minimatch,
#    glob, cross-spawn… — qui pèsent une vingtaine de CVE hautes. On le retire.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
# dist/ compilé sur le runner (plus de tsc dans Docker)
COPY --chown=1001:1001 apps/api/dist           ./dist
COPY --chown=1001:1001 apps/api/src/assets     ./dist/assets
COPY --from=deploy --chown=1001:1001 /out/node_modules ./node_modules
COPY --chown=1001:1001 apps/api/package.json   ./package.json
USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1
CMD ["node", "dist/index.js"]
