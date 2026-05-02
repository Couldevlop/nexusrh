# ── Stage 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@9.4.0 --quiet

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm config set network-timeout 600000 --global \
 && pnpm config set node-linker hoisted --global \
 && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/worker/ ./apps/worker/

RUN pnpm --filter @nexusrhci/worker run build

# ── Stage 2 : runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs

COPY --from=builder --chown=1001:1001 /build/apps/worker/dist ./dist
COPY --from=builder --chown=1001:1001 /build/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /build/apps/worker/package.json ./package.json

USER 1001

CMD ["node", "dist/index.js"]
