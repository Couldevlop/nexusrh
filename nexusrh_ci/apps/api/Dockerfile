FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
COPY --chown=1001:1001 apps/api/dist           ./dist
COPY --chown=1001:1001 apps/api/.deploy/node_modules ./node_modules
COPY --chown=1001:1001 apps/api/package.json   ./package.json
USER 1001
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1
CMD ["node", "dist/index.js"]
