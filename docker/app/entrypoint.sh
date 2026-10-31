#!/bin/sh
# Entry point of the slax-app image: prepares the writable paths and the configuration
# cache, then runs the command (php-fpm by default; reverb, queue, scheduler, migrations).
set -eu

cd /var/www/html

# The root filesystem is read-only in Kubernetes: storage/ and /tmp are emptyDir volumes,
# which start empty. storage/framework/cache/data must exist and be writable: the alert
# fallback used while Redis is down writes there (Task 11).
mkdir -p storage/app/private storage/framework/cache/data storage/framework/sessions \
    storage/framework/views storage/logs "$(dirname "${APP_CONFIG_CACHE:-/tmp/slax/config.php}")"

# Configuration is cached here, at start, from this container's environment (APP_CONFIG_CACHE
# points into /tmp): never in the image, since it carries secrets.
if [ "${SLAX_CONFIG_CACHE:-true}" = "true" ]; then
    (umask 077 && php artisan config:cache --no-interaction >/dev/null)
fi

exec "$@"
