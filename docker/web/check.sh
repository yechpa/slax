#!/bin/sh
# Checks a slax-web image's routes and headers, with a stub PHP-FPM in place of the API:
#   docker/web/check.sh <image>          (make web-check; CI runs it on every web build)
# Needs docker and curl. Exits non-zero on the first failed check.
set -eu

image="${1:?usage: $0 <slax-web image>}"
php_image="php:8.4.27-fpm-alpine3.24@sha256:93aa3f61216b73cc6f878235c9772849449f4efc18dfe3d6678eed645076c00d"
name="slax-web-check-$$"
dir="$(mktemp -d)"
trap 'docker rm -f "$name-php" "$name-web" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

# The stub API: a file download answers like FileController::download (redirect, no-referrer);
# anything else echoes what PHP was told about the request.
cat > "$dir/index.php" <<'PHP'
<?php
if (str_starts_with($_SERVER['REQUEST_URI'], '/api/v1/files/')) {
    header('Referrer-Policy: no-referrer');
    header('Location: https://files.example.test/object', true, 302);
    exit;
}
header('Content-Type: application/json');
echo json_encode(['https' => $_SERVER['HTTPS'] ?? '', 'remote' => $_SERVER['REMOTE_ADDR']]);
PHP
chmod 755 "$dir" && chmod 644 "$dir/index.php"

docker run -d --name "$name-php" -p 127.0.0.1::8080 -v "$dir:/var/www/html/public:ro" "$php_image" >/dev/null
docker run -d --name "$name-web" --network "container:$name-php" --read-only --tmpfs /tmp:mode=1777 \
    -e SLAX_PUBLIC_URL=https://slax.example.test \
    -e SLAX_FILES_ORIGIN=https://files.example.test \
    -e SLAX_REVERB_UPSTREAM=127.0.0.1:8081 \
    -e SLAX_TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 \
    -e TURNSTILE_SITE_KEY=test-site-key -e REVERB_APP_KEY=test-app-key \
    "$image" >/dev/null
base="http://$(docker port "$name-php" 8080/tcp | head -1)"

for _ in $(seq 1 30); do
    curl -fs -o /dev/null "$base/healthz" && break
    sleep 1
done

failures=0
check() { # description, command...
    description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
headers() { curl -s -o /dev/null -D - "$@" | tr -d '\r'; }
has() { printf '%s\n' "$1" | grep -qiE "$2"; }
count() { printf '%s\n' "$1" | grep -ciE "$2" || true; }

page="$(headers "$base/channels/general")"
body="$(curl -s "$base/channels/general")"
check "SPA routes answer 200" has "$page" '^HTTP/1.1 200'
check "CSP: same origin, no framing, no base, no plugins" has "$page" "^content-security-policy: default-src 'self';.*frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
check "CSP: no inline script or style" sh -c "! printf '%s' \"\$1\" | grep -qi 'unsafe-inline'" _ "$page"
check "CSP: previews from the files host, WebSocket to the own host" has "$page" "img-src 'self' data: https://files.example.test;.*connect-src 'self' wss://slax.example.test"
check "nosniff" has "$page" '^x-content-type-options: nosniff'
check "Referrer-Policy (default)" has "$page" '^referrer-policy: strict-origin-when-cross-origin$'
check "Permissions-Policy" has "$page" '^permissions-policy: camera=\(\)'
check "no HSTS unless asked (the TLS terminator sets it)" sh -c "! printf '%s' \"\$1\" | grep -qi '^strict-transport-security'" _ "$page"
check "index.html is not cached" has "$page" '^cache-control: no-cache'
check "the page carries the public settings" has "$body" '<meta name="slax:turnstile-site-key" content="test-site-key" /><meta name="slax:reverb-app-key" content="test-app-key" />'

api="$(headers "$base/api/v1/health")"
check "API through PHP-FPM, with the security headers" has "$api" "^content-security-policy: default-src 'self'"
check "PHP is told the public scheme is https" has "$(curl -s "$base/api/v1/health")" '"https":"on"'
check "the visitor's address comes from X-Forwarded-For of a trusted proxy" \
    has "$(curl -s -H 'X-Forwarded-For: 203.0.113.7' "$base/api/v1/health")" '"remote":"203.0.113.7"'

download="$(headers "$base/api/v1/files/1/download")"
check "a download keeps the API's Referrer-Policy: no-referrer" has "$download" '^referrer-policy: no-referrer$'
check "... and only that one" test "$(count "$download" '^referrer-policy:')" = 1

check "Reverb's HTTP API is not served (/apps/ -> 404)" has "$(headers "$base/apps/1/events")" '^HTTP/1.1 404'
check "/app/ accepts WebSocket upgrades only (-> 426)" has "$(headers "$base/app/key")" '^HTTP/1.1 426'

asset="$(printf '%s' "$body" | grep -oE '/assets/[^"]+\.js' | head -1)"
check "bundle files are cached for good" has "$(headers "$base$asset")" '^cache-control: public, max-age=31536000, immutable'

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    docker logs "$name-web" 2>&1 | tail -20
    exit 1
fi
echo "All web checks passed"
