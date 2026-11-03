ARG NGINX_IMAGE=docker.io/library/nginx:1.28.0-alpine
FROM ${NGINX_IMAGE}
ARG SOURCE_REVISION=unknown
ARG WEB_REVISION=unknown
LABEL org.opencontainers.image.title="Naia local web shell" \
      org.opencontainers.image.source="https://github.com/nextain/naia-shell" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.naia.web.revision="${WEB_REVISION}"
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
COPY web/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
ENTRYPOINT ["sh", "/entrypoint.sh"]
