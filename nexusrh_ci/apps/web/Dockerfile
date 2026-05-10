FROM nginx:1.27-alpine
COPY apps/web/dist         /usr/share/nginx/html
COPY apps/web/nginx.conf   /etc/nginx/conf.d/default.conf
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
