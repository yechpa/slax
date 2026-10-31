# syntax=docker/dockerfile:1
#
# Production image of the web front: ghcr.io/yechpa/slax-web. nginx serving the built SPA
# and, on the same origin, forwarding the API to PHP-FPM (slax-app, same pod, 127.0.0.1:9000)
# and the WebSocket path /app/ to Reverb. It sets the security headers (strict CSP); HSTS is
# left to the TLS terminator unless SLAX_HSTS_MAX_AGE says otherwise. See entrypoint.sh for
# the settings it reads at start.
#
# Build from the repository root (the files it reads are listed in Dockerfile.dockerignore):
#   docker build -f docker/web/Dockerfile -t slax-web .
#
# Runs as nginx's unprivileged user on a read-only root filesystem: only /tmp is written.

ARG NODE_IMAGE=node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ARG NGINX_IMAGE=nginx:1.30.6-alpine3.24-slim@sha256:dede8895648b461178c3bc604f7eed4423efe5220b2c4d839f5eb3d34ac3f8f7

# The production bundle (`npm run build`: type check, then `vite build` in production mode).
# Never the end-to-end build: vite.config.ts refuses VITE_E2E outside `--mode e2e`. The
# bundle is the same for every architecture, so it is built on the builder's own platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build \
    && test -f dist/index.html \
    && test ! -e dist/design-system.html \
    && ! grep -rqs 'auth/e2e' dist

FROM ${NGINX_IMAGE} AS runtime
# The image's own entry point scripts and default site are replaced by ours.
RUN rm -rf /docker-entrypoint.sh /docker-entrypoint.d /etc/nginx/conf.d /usr/share/nginx/html \
    && mkdir -p /etc/nginx/slax
COPY docker/web/nginx.conf /etc/nginx/nginx.conf
COPY docker/web/slax.conf.template /etc/nginx/slax/slax.conf.template
COPY --chmod=0755 docker/web/entrypoint.sh /usr/local/bin/slax-web-entrypoint
COPY --from=build /src/dist/ /usr/share/nginx/html/
# index.html is written to /tmp at start, with the deployment's public settings in it.
RUN mv /usr/share/nginx/html/index.html /etc/nginx/slax/index.html

USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["slax-web-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
