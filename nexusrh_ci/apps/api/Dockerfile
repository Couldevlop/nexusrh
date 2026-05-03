# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-timeout 600000 --global \
 && pnpm config set node-linker hoisted --global \
 && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/api/ ./apps/api/

WORKDIR /build/apps/api
RUN /build/node_modules/.bin/tsc -p tsconfig.build.json

# ── Stage 2 : runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=builder --chown=1001:1001 /build/apps/api/dist ./dist
COPY --from=builder --chown=1001:1001 /build/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /build/apps/api/package.json ./package.json

USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["node", "dist/index.js"]
