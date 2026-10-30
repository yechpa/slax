#!/bin/sh
# Entry point of the slax-web image: renders the nginx site, the security headers and
# index.html from the environment into /tmp (the root filesystem is read-only), then runs
# nginx. Every value is checked first: a bad one stops the container instead of producing a
# broken or weakened Content-Security-Policy.
#
#   SLAX_PUBLIC_URL        required  https://dev.slax.yechpa.com (scheme and host, no path)
#   SLAX_FILES_ORIGIN      optional  where file previews are loaded from (presigned URLs),
#                                    added to img-src, e.g. https://files.slax.yechpa.com
#   SLAX_TURNSTILE_ORIGIN  optional  Cloudflare Turnstile (script-src, frame-src);
#                                    default https://challenges.cloudflare.com, "none" drops it
#   SLAX_PHP_UPSTREAM      optional  PHP-FPM, default 127.0.0.1:9000 (same pod)
#   SLAX_REVERB_UPSTREAM   optional  Reverb, default slax-reverb:8080
#   SLAX_TRUSTED_PROXIES   optional  comma-separated addresses/CIDRs whose X-Forwarded-For
#                                    is believed (the ingress controller's pod network)
#   SLAX_HSTS_MAX_AGE      optional  seconds; 0 (default): no Strict-Transport-Security here,
#                                    the TLS terminator in front sets it
#   TURNSTILE_SITE_KEY     public    written into index.html (lib/publicConfig.ts)
#   REVERB_APP_KEY         public    written into index.html (lib/publicConfig.ts)
set -eu

fail() {
    echo "slax-web: $*" >&2
    exit 1
}

matches() { # value, extended regular expression it must match whole (an empty value never does)
    printf '%s' "$1" | grep -Eqx "$2"
}

HOST_RE='[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?'
ORIGIN_RE="https?://${HOST_RE}"

SLAX_PUBLIC_URL="${SLAX_PUBLIC_URL:-}"
SLAX_FILES_ORIGIN="${SLAX_FILES_ORIGIN:-}"
SLAX_TURNSTILE_ORIGIN="${SLAX_TURNSTILE_ORIGIN:-https://challenges.cloudflare.com}"
SLAX_PHP_UPSTREAM="${SLAX_PHP_UPSTREAM:-127.0.0.1:9000}"
SLAX_REVERB_UPSTREAM="${SLAX_REVERB_UPSTREAM:-slax-reverb:8080}"
SLAX_TRUSTED_PROXIES="${SLAX_TRUSTED_PROXIES:-}"
SLAX_HSTS_MAX_AGE="${SLAX_HSTS_MAX_AGE:-0}"
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}"
REVERB_APP_KEY="${REVERB_APP_KEY:-}"

matches "$SLAX_PUBLIC_URL" "$ORIGIN_RE" || fail "SLAX_PUBLIC_URL must be scheme://host[:port] (got '${SLAX_PUBLIC_URL}')"
[ -z "$SLAX_FILES_ORIGIN" ] || matches "$SLAX_FILES_ORIGIN" "$ORIGIN_RE" || fail "SLAX_FILES_ORIGIN must be scheme://host[:port]"
[ "$SLAX_TURNSTILE_ORIGIN" = none ] || matches "$SLAX_TURNSTILE_ORIGIN" "https://${HOST_RE}" || fail "SLAX_TURNSTILE_ORIGIN must be https://host or none"
matches "$SLAX_PHP_UPSTREAM" '[A-Za-z0-9.-]+:[0-9]{1,5}' || fail "SLAX_PHP_UPSTREAM must be host:port"
matches "$SLAX_REVERB_UPSTREAM" '[A-Za-z0-9.-]+:[0-9]{1,5}' || fail "SLAX_REVERB_UPSTREAM must be host:port"
[ -z "$SLAX_TRUSTED_PROXIES" ] || matches "$SLAX_TRUSTED_PROXIES" '[0-9A-Fa-f.:/, ]+' || fail "SLAX_TRUSTED_PROXIES must be addresses or CIDRs"
matches "$SLAX_HSTS_MAX_AGE" '[0-9]{1,9}' || fail "SLAX_HSTS_MAX_AGE must be a number of seconds"
[ -z "$TURNSTILE_SITE_KEY" ] || matches "$TURNSTILE_SITE_KEY" '[A-Za-z0-9_-]+' || fail "TURNSTILE_SITE_KEY has unexpected characters"
[ -z "$REVERB_APP_KEY" ] || matches "$REVERB_APP_KEY" '[A-Za-z0-9_-]+' || fail "REVERB_APP_KEY has unexpected characters"
[ -n "$TURNSTILE_SITE_KEY" ] || echo "slax-web: warning: no TURNSTILE_SITE_KEY, the page uses the build's (a test key)" >&2
[ -n "$REVERB_APP_KEY" ] || echo "slax-web: warning: no REVERB_APP_KEY, the page uses the build's" >&2

public_scheme="${SLAX_PUBLIC_URL%%://*}"
public_host="${SLAX_PUBLIC_URL#*://}"

mkdir -p /tmp/nginx/conf.d /tmp/nginx/html

# Content-Security-Policy: same origin for everything, except file previews (the files
# host), Turnstile's script and frame, and the WebSocket (ws/wss of this same host). No
# inline script or style anywhere.
turnstile=""
frames="'none'"
if [ "$SLAX_TURNSTILE_ORIGIN" != none ]; then
    turnstile=" $SLAX_TURNSTILE_ORIGIN"
    frames="$SLAX_TURNSTILE_ORIGIN"
fi
files=""
[ -z "$SLAX_FILES_ORIGIN" ] || files=" $SLAX_FILES_ORIGIN"
if [ "$public_scheme" = https ]; then
    websocket="wss://$public_host"
    upgrade="; upgrade-insecure-requests"
    fastcgi_https=on
else
    websocket="ws://$public_host"
    upgrade=""
    fastcgi_https=""
fi
csp="default-src 'self'; script-src 'self'${turnstile}; style-src 'self'; img-src 'self' data:${files}; font-src 'self'; connect-src 'self' ${websocket}; frame-src ${frames}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; manifest-src 'self'${upgrade}"

{
    echo "add_header Content-Security-Policy \"$csp\" always;"
    echo 'add_header X-Content-Type-Options "nosniff" always;'
    echo 'add_header X-Frame-Options "DENY" always;'
    echo 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;'
    echo 'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" always;'
    echo 'add_header Cross-Origin-Opener-Policy "same-origin" always;'
    if [ "$SLAX_HSTS_MAX_AGE" -gt 0 ]; then
        echo "add_header Strict-Transport-Security \"max-age=$SLAX_HSTS_MAX_AGE; includeSubDomains\" always;"
    fi
} > /tmp/nginx/security-headers.conf

{
    for proxy in $(printf '%s' "$SLAX_TRUSTED_PROXIES" | tr ',' ' '); do
        echo "set_real_ip_from $proxy;"
    done
    echo 'real_ip_header X-Forwarded-For;'
    echo 'real_ip_recursive on;'
} > /tmp/nginx/real-ip.conf

SLAX_FASTCGI_HTTPS="$fastcgi_https"
export SLAX_PHP_UPSTREAM SLAX_REVERB_UPSTREAM SLAX_FASTCGI_HTTPS
envsubst '${SLAX_PHP_UPSTREAM} ${SLAX_REVERB_UPSTREAM} ${SLAX_FASTCGI_HTTPS}' \
    < /etc/nginx/slax/slax.conf.template > /tmp/nginx/conf.d/slax.conf

# index.html with the public settings the browser reads (frontend/src/lib/publicConfig.ts).
meta=""
[ -z "$TURNSTILE_SITE_KEY" ] || meta="${meta}<meta name=\"slax:turnstile-site-key\" content=\"${TURNSTILE_SITE_KEY}\" />"
[ -z "$REVERB_APP_KEY" ] || meta="${meta}<meta name=\"slax:reverb-app-key\" content=\"${REVERB_APP_KEY}\" />"
sed "s|</head>|${meta}</head>|" /etc/nginx/slax/index.html > /tmp/nginx/html/index.html
grep -q '</head>' /tmp/nginx/html/index.html || fail "index.html has no </head>"

exec "$@"
