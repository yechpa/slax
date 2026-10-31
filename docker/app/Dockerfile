# syntax=docker/dockerfile:1
#
# Production image of the Laravel backend: ghcr.io/yechpa/slax-app.
# One image, several processes, chosen by the command (see deploy/helm/slax):
#   php-fpm (default)                          the API, behind nginx (slax-web) in the same pod
#   php artisan reverb:start ...               the WebSocket server
#   php artisan queue:work ...                 the queue worker
#   php artisan schedule:work                  the scheduler
#   php artisan migrate --force ...            the migration Job
#
# Build from the repository root (the files it reads are listed in Dockerfile.dockerignore):
#   docker build -f docker/app/Dockerfile -t slax-app .
#
# Runs as an unprivileged user on a read-only root filesystem: only /tmp and
# /var/www/html/storage must be writable (emptyDir volumes in Kubernetes, tmpfs with
# `docker run --read-only`). The configuration comes from the environment at start and
# is never baked in: it carries secrets. Base images are pinned by version and digest
# (multi-architecture indexes: the same line builds linux/amd64 and linux/arm64).

ARG PHP_IMAGE=php:8.4.27-fpm-alpine3.24@sha256:93aa3f61216b73cc6f878235c9772849449f4efc18dfe3d6678eed645076c00d
ARG COMPOSER_IMAGE=composer:2.11.0@sha256:278dfc7bd35169965d03f87194816f43bf4e6b6ea61707c2114e52ad12fe24ce
ARG EXTENSION_INSTALLER_IMAGE=ghcr.io/mlocati/php-extension-installer:2@sha256:35821db0661308f64aa18483bb3af56bedc3b40090ff441ed961327d1ccbceb8

FROM ${COMPOSER_IMAGE} AS composer
FROM ${EXTENSION_INSTALLER_IMAGE} AS extension-installer

# PHP with the extensions the backend uses (the same list as the development image,
# docker/php/Dockerfile), compiled for the build's own architecture. `apk upgrade`: Alpine's
# security fixes published since the base image was built (CI's Trivy gate fails on fixable
# critical ones). fcgi: cgi-fcgi, for the PHP-FPM health check. tini: PID 1, so a stop
# signal reaches the process (PHP as PID 1 ignores SIGTERM unless it handles it, and would
# wait for the kill).
FROM ${PHP_IMAGE} AS php
RUN --mount=type=bind,from=extension-installer,source=/usr/bin/install-php-extensions,target=/usr/local/bin/install-php-extensions \
    install-php-extensions pdo_pgsql redis pcntl bcmath intl zip opcache \
    && apk upgrade --no-cache \
    && apk add --no-cache fcgi tini \
    && rm -rf /tmp/* /var/cache/apk/*

# Dependencies without the development tools, an optimized autoloader, and the caches that
# do not depend on the environment: package discovery, routes and events. Production routes
# only (APP_ENV=production: the end-to-end stand-in for Google is never registered).
FROM php AS build
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME=/tmp/composer APP_ENV=production APP_DEBUG=false LOG_CHANNEL=stderr
WORKDIR /build
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY backend/composer.json backend/composer.lock ./
RUN --mount=type=bind,source=docker/app/trim-aws-sdk.php,target=/usr/local/share/trim-aws-sdk.php \
    composer install --no-dev --no-interaction --no-progress --prefer-dist --no-scripts --no-autoloader \
    && php /usr/local/share/trim-aws-sdk.php
COPY backend/ ./
RUN composer dump-autoload --no-dev --optimize --no-interaction \
    && php artisan route:cache --no-interaction \
    && php artisan event:cache --no-interaction \
    && rm -rf storage/framework/cache/data/* storage/logs/* /tmp/composer

FROM php AS runtime
RUN addgroup -S -g 10001 slax \
    && adduser -S -D -u 10001 -G slax -H -h /var/www/html -s /sbin/nologin slax \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
    && rm -f /usr/local/etc/php-fpm.d/*.conf
COPY docker/app/php.ini $PHP_INI_DIR/conf.d/zz-slax.ini
COPY docker/app/php-fpm.conf /usr/local/etc/php-fpm.d/slax.conf
COPY --chmod=0755 docker/app/entrypoint.sh /usr/local/bin/slax-entrypoint

WORKDIR /var/www/html
# The code is root's (read-only for the app); only storage/ belongs to the app user.
COPY --from=build /build ./
RUN mkdir -p storage/app/private storage/framework/cache/data storage/framework/sessions \
        storage/framework/views storage/logs \
    && chown -R slax:slax storage \
    && php -m | grep -qx pdo_pgsql

# HOME: tools that keep state (tinker's history) write under /tmp, the only writable place.
ENV APP_ENV=production \
    APP_DEBUG=false \
    LOG_CHANNEL=stderr \
    APP_CONFIG_CACHE=/tmp/slax/config.php \
    HOME=/tmp

USER 10001:10001
EXPOSE 9000
# PHP-FPM's own ping (only meaningful for the default command; Kubernetes uses its probes).
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD SCRIPT_NAME=/fpm-ping SCRIPT_FILENAME=/fpm-ping REQUEST_METHOD=GET \
        cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q pong || exit 1
ENTRYPOINT ["/sbin/tini", "--", "slax-entrypoint"]
CMD ["php-fpm"]
