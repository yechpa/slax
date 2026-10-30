# Dev image for the Laravel services (app, reverb, queue, scheduler).
# Production image: docker/app/Dockerfile (slax-app), with docker/web for nginx (slax-web).
FROM php:8.4-fpm-alpine

COPY --from=ghcr.io/mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions pdo_pgsql redis pcntl bcmath intl zip opcache \
    && apk add --no-cache git unzip

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
COPY php.ini /usr/local/etc/php/conf.d/zz-slax.ini
COPY php-fpm.conf /usr/local/etc/php-fpm.d/zz-slax.conf

# The compose file runs containers as the host user so bind-mounted files stay
# owned by the developer; HOME must be writable for composer's cache.
ENV HOME=/tmp COMPOSER_HOME=/tmp/composer
WORKDIR /var/www/html
