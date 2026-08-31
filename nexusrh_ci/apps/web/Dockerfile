FROM nginx:1.27-alpine
# Le tag nginx:1.27-alpine est figé sur les paquets Alpine du jour de sa
# publication : il traînait 1 CVE critique et ~25 hautes (openssl, libpng,
# libxml2, libexpat, zlib, curl, musl…). `apk upgrade` applique les correctifs
# publiés depuis, sans changer de version de nginx.
RUN apk upgrade --no-cache
COPY apps/web/dist         /usr/share/nginx/html
COPY apps/web/nginx.conf   /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chown -R 101:101 /usr/share/nginx/html \
 && chown -R 101:101 /var/cache/nginx \
 && chown -R 101:101 /var/log/nginx \
 && touch /var/run/nginx.pid \
 && chown 101:101 /var/run/nginx.pid \
 && chmod +x /docker-entrypoint.sh
USER 101
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1
ENTRYPOINT ["/docker-entrypoint.sh"]
