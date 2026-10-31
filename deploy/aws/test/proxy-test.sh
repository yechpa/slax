#!/usr/bin/env bash
# The production front path, in containers: Caddy (deploy/aws/Caddyfile, Caddy's internal CA
# instead of Let's Encrypt) -> slax-web (nginx, the real image) -> a stub PHP-FPM that echoes
# what PHP is told about the client. Proves that a client cannot choose its own address with
# X-Forwarded-For / X-Real-IP, that HSTS comes from Caddy, and that /apps/ is closed.
#
#   deploy/aws/test/proxy-test.sh <slax-web image>     (make proxy-test)
#
# Needs docker only. Uses its own network (fixed addresses, so nginx trusts exactly Caddy's
# address, as production trusts only the node) and removes everything on exit.
set -euo pipefail

web_image="${1:?usage: $0 <slax-web image>}"
caddy_image="caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f"
php_image="php:8.4.27-fpm-alpine3.24@sha256:93aa3f61216b73cc6f878235c9772849449f4efc18dfe3d6678eed645076c00d"
curl_image="curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

name="slax-proxy-test-$$"
subnet="${PROXY_TEST_SUBNET:-172.31.253.0/24}"
prefix="${subnet%.*}"
caddy_ip="$prefix.10"
web_ip="$prefix.20"
client_ip="$prefix.30"
other_ip="$prefix.40"
dir="$(mktemp -d)"

cleanup() {
    docker rm -f "$name-caddy" "$name-web" "$name-php" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    rm -rf "$dir"
}
trap cleanup EXIT

# The stub API: what PHP is told about the request.
cat > "$dir/index.php" <<'PHP'
<?php
header('Content-Type: application/json');
echo json_encode([
    'remote' => $_SERVER['REMOTE_ADDR'],
    'xff' => $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '',
    'real' => $_SERVER['HTTP_X_REAL_IP'] ?? '',
    'https' => $_SERVER['HTTPS'] ?? '',
]);
PHP
chmod 755 "$dir" && chmod 644 "$dir/index.php"

docker network create --subnet "$subnet" "$name" >/dev/null
docker run -d --name "$name-php" --network "$name" --ip "$web_ip" \
    -v "$dir:/var/www/html/public:ro" "$php_image" >/dev/null
docker run -d --name "$name-web" --network "container:$name-php" --read-only --tmpfs /tmp:mode=1777 \
    -e SLAX_PUBLIC_URL=https://slax.test \
    -e SLAX_FILES_ORIGIN=https://slax-files-example.s3.eu-central-1.amazonaws.com \
    -e SLAX_REVERB_UPSTREAM=127.0.0.1:8081 \
    -e SLAX_TRUSTED_PROXIES="$caddy_ip/32" \
    -e TURNSTILE_SITE_KEY=test-site-key -e REVERB_APP_KEY=test-app-key \
    "$web_image" >/dev/null
docker run -d --name "$name-caddy" --network "$name" --ip "$caddy_ip" \
    -e SLAX_SITE_ADDRESS=slax.test -e SLAX_UPSTREAM="$web_ip:8080" -e SLAX_TLS=internal \
    -v "$repo/deploy/aws/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" >/dev/null

# curl from a client container at a known address. Arguments: the client's address, then curl's.
client() {
    local ip="$1"
    shift
    docker run --rm --network "$name" --ip "$ip" "$curl_image" \
        --silent --show-error --max-time 10 --insecure --resolve "slax.test:443:$caddy_ip" --resolve "slax.test:80:$caddy_ip" "$@"
}

for _ in $(seq 1 30); do
    if client "$client_ip" -o /dev/null --fail "https://slax.test/healthz" 2>/dev/null; then break; fi
    sleep 1
done

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
has() { printf '%s\n' "$1" | grep -qiE -- "$2"; }
hasall() { # text, patterns...: every pattern matches
    text="$1"
    shift
    for pattern in "$@"; do has "$text" "$pattern" || return 1; done
}
hasnt() { ! printf '%s\n' "$1" | grep -qiE -- "$2"; }

plain="$(client "$client_ip" "https://slax.test/api/v1/health")"
check "through Caddy, PHP sees the client's own address" has "$plain" "\"remote\":\"$client_ip\""
check "... over HTTPS (Laravel is told https)" has "$plain" '"https":"on"'

spoofed="$(client "$client_ip" -H 'X-Forwarded-For: 6.6.6.6' -H 'X-Real-IP: 6.6.6.6' "https://slax.test/api/v1/health")"
check "a forged X-Forwarded-For / X-Real-IP does not change the address PHP sees" has "$spoofed" "\"remote\":\"$client_ip\""
check "... Caddy replaced the forged X-Forwarded-For instead of passing it on" has "$spoofed" "\"xff\":\"$client_ip\""
check "... and the forged X-Real-IP" has "$spoofed" "\"real\":\"$client_ip\""
check "... the forged address appears nowhere" hasnt "$spoofed" '6\.6\.6\.6'

chain="$(client "$client_ip" -H "X-Forwarded-For: $caddy_ip, 6.6.6.6" "https://slax.test/api/v1/health")"
check "a forged chain naming the trusted proxy is discarded too" has "$chain" "\"remote\":\"$client_ip\""

other="$(client "$other_ip" -H 'X-Forwarded-For: 6.6.6.6' "https://slax.test/api/v1/health")"
check "another client is seen as itself" has "$other" "\"remote\":\"$other_ip\""

direct="$(docker run --rm --network "$name" --ip "$client_ip" "$curl_image" --silent --max-time 10 \
    -H 'X-Forwarded-For: 6.6.6.6' "http://$web_ip:8080/api/v1/health")"
check "straight to nginx (not via the trusted proxy), X-Forwarded-For is ignored" has "$direct" "\"remote\":\"$client_ip\""

headers="$(client "$client_ip" -o /dev/null -D - "https://slax.test/channels/general" | tr -d '\r')"
check "HSTS from Caddy: one year, subdomains, no preload" has "$headers" '^strict-transport-security: max-age=31536000; includeSubDomains$'
check "exactly one HSTS header" test "$(printf '%s\n' "$headers" | grep -ci '^strict-transport-security:')" = 1
check "nginx's CSP passes through, with the bucket's host in img-src" has "$headers" "^content-security-policy: default-src 'self';.*img-src 'self' data: https://slax-files-example.s3.eu-central-1.amazonaws.com;"
check "no Server header" hasnt "$headers" '^server:'

# The PWA through Caddy: the service worker and manifest keep nginx's headers.
sw="$(client "$client_ip" -o /dev/null -D - "https://slax.test/sw.js" | tr -d '\r')"
check "the service worker reaches the browser (200, JavaScript)" hasall "$sw" '^HTTP/[0-9.]+ 200' '^content-type: (application|text)/javascript'
check "... revalidated on every check (Cache-Control: no-cache)" has "$sw" '^cache-control: no-cache$'
check "... with Service-Worker-Allowed: /" has "$sw" '^service-worker-allowed: /$'
check "... and HSTS from Caddy" has "$sw" '^strict-transport-security: max-age=31536000; includeSubDomains$'
manifest="$(client "$client_ip" -o /dev/null -D - "https://slax.test/manifest.webmanifest" | tr -d '\r')"
check "the manifest reaches the browser as application/manifest+json" has "$manifest" '^content-type: application/manifest\+json'

apps="$(client "$client_ip" -o /dev/null -w '%{http_code}' "https://slax.test/apps/1/events")"
check "Reverb's HTTP API is refused at Caddy (/apps/ -> 404)" test "$apps" = 404
ws="$(client "$client_ip" -o /dev/null -w '%{http_code}' "https://slax.test/app/key")"
check "/app/ reaches nginx (no upgrade -> 426 from nginx)" test "$ws" = 426

redirect="$(client "$client_ip" -o /dev/null -w '%{http_code} %{redirect_url}' "http://slax.test/channels/general")"
check "plain HTTP redirects to HTTPS" has "$redirect" '^30[18] https://slax.test/channels/general$'

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    docker logs "$name-caddy" 2>&1 | tail -20
    docker logs "$name-web" 2>&1 | tail -20
    exit 1
fi
echo "All front-proxy checks passed"
