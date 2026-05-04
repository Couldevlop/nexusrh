# syntax=docker/dockerfile:1.7
# Pattern officiel pnpm + Docker : https://pnpm.io/docker

FROM node:20-alpine AS pnpmstore

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

RUN --mount=from=pnpmstore,target=/mnt/store \
    mkdir -p /pnpm/store/v3 \
 && ([ -d /mnt/store/files ] && cp -a /mnt/store/. /pnpm/store/v3/ || true)

RUN pnpm config set network-timeout 600000 --global \
 && pnpm config set fetch-retries 5 --global \
 && pnpm install --frozen-lockfile --ignore-scripts --prefer-offline \
    --filter @nexusrhci/web

COPY tsconfig.base.json ./
COPY apps/web/ ./apps/web/

RUN node_modules/.bin/vite build --outDir apps/web/dist

# ── Runner : nginx sert les fichiers statiques, pas besoin de node_modules ───
FROM nginx:1.27-alpine AS runner

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

RUN chown -R 101:101 /usr/share/nginx/html \
 && chown -R 101:101 /var/cache/nginx \
 && chown -R 101:101 /var/log/nginx \
 && touch /var/run/nginx.pid \
 && chown 101:101 /var/run/nginx.pid

USER 101
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
