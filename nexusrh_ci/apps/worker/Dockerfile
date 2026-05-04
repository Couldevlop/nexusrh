FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
COPY --chown=1001:1001 apps/worker/dist           ./dist
COPY --chown=1001:1001 apps/worker/.deploy/node_modules ./node_modules
COPY --chown=1001:1001 apps/worker/package.json   ./package.json
USER 1001
CMD ["node", "dist/index.js"]
