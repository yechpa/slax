#!/usr/bin/env bash
# deploy/dev/slax-lan-guard.sh in a throwaway container standing in for slax-dev, with two
# networks: eth0 plays the LAN, eth1 the NetBird overlay (wt0): make lan-guard-test.
#
# Checks: start is idempotent (one jump); from the LAN, 80/443/6443 time out while 22 answers;
# from the overlay, 443/6443 and ping answer while 22/80/8080 time out; the node itself
# (loopback) reaches everything; status reports both kinds; an interface listed as LAN and
# overlay is refused; stop removes everything and is harmless twice.
set -euo pipefail

alpine_image="alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
name="slax-lan-guard-test-$$"

cleanup() {
    docker rm -f "$name-node" >/dev/null 2>&1 || true
    docker network rm "$name-lan" "$name-overlay" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}

docker network create "$name-lan" >/dev/null
docker network create "$name-overlay" >/dev/null
# The "node": iptables, and listeners on the ports that matter.
docker run -d --name "$name-node" --network "$name-lan" --cap-add NET_ADMIN \
    -v "$repo/deploy/dev/slax-lan-guard.sh:/usr/local/sbin/slax-lan-guard:ro" "$alpine_image" \
    sh -c 'apk add -q --no-cache iptables ip6tables iproute2 >/dev/null && touch /ready \
        && for p in 22 80 443 6443 8080; do (while true; do echo ok | nc -l -p $p >/dev/null 2>&1; done) & done; sleep 3600' >/dev/null
docker network connect "$name-overlay" "$name-node"
for _ in $(seq 1 60); do docker exec "$name-node" test -e /ready 2>/dev/null && break; sleep 1; done
ip_on() { docker inspect -f "{{(index .NetworkSettings.Networks \"$1\").IPAddress}}" "$name-node"; }
lan_ip="$(ip_on "$name-lan")"
overlay_ip="$(ip_on "$name-overlay")"
lan_if="$(docker exec "$name-node" ip -o -4 addr show | awk -v ip="$lan_ip" 'index($4, ip "/") == 1 {print $2}')"
overlay_if="$(docker exec "$name-node" ip -o -4 addr show | awk -v ip="$overlay_ip" 'index($4, ip "/") == 1 {print $2}')"
docker exec "$name-node" sh -c "mkdir -p /etc/default && printf 'LAN_INTERFACES=%s\nOVERLAY_INTERFACES=%s\n' $lan_if $overlay_if > /etc/default/slax-lan-guard"

guard() { docker exec "$name-node" sh /usr/local/sbin/slax-lan-guard "$@"; }
# reach NETWORK IP PORT: does a TCP connection from another container answer within 3 s?
reach() { docker run --rm --network "$1" "$alpine_image" sh -c "echo | nc -w 3 $2 $3 | grep -q ok"; }
unreachable() { ! reach "$@"; }
pings() { docker run --rm --network "$1" "$alpine_image" ping -c 1 -W 3 "$2" >/dev/null 2>&1; }

check "before the guard: 22 answers on the overlay (the test can see a drop)" reach "$name-overlay" "$overlay_ip" 22

guard start
guard start
check "start twice: one jump from PREROUTING" test "$(docker exec "$name-node" iptables -t mangle -S PREROUTING | grep -c 'SLAX-LAN-GUARD')" = 1

check "LAN: 443 times out" unreachable "$name-lan" "$lan_ip" 443
check "LAN: 6443 times out" unreachable "$name-lan" "$lan_ip" 6443
check "LAN: 80 times out" unreachable "$name-lan" "$lan_ip" 80
check "LAN: SSH (22) still answers" reach "$name-lan" "$lan_ip" 22

check "overlay: 443 answers" reach "$name-overlay" "$overlay_ip" 443
check "overlay: 6443 answers" reach "$name-overlay" "$overlay_ip" 6443
check "overlay: ping answers" pings "$name-overlay" "$overlay_ip"
check "overlay: 22 times out" unreachable "$name-overlay" "$overlay_ip" 22
check "overlay: 80 times out" unreachable "$name-overlay" "$overlay_ip" 80
check "overlay: another port (8080) times out" unreachable "$name-overlay" "$overlay_ip" 8080

check "the node itself (loopback) still reaches 22 and 6443" \
    docker exec "$name-node" sh -c 'echo | nc -w 3 127.0.0.1 22 | grep -q ok && echo | nc -w 3 127.0.0.1 6443 | grep -q ok'
status="$(guard status)"
check "status: the LAN interface guarded" sh -c "printf '%s\n' \"\$1\" | grep -q '$lan_if guarded'" _ "$status"
check "status: the overlay interface guarded" sh -c "printf '%s\n' \"\$1\" | grep -q '$overlay_if (overlay) guarded'" _ "$status"

docker exec "$name-node" sh -c "printf 'LAN_INTERFACES=%s\nOVERLAY_INTERFACES=%s\n' $lan_if $lan_if > /etc/default/slax-lan-guard"
check "an interface that is both LAN and overlay is refused" sh -c "! docker exec $name-node sh /usr/local/sbin/slax-lan-guard start 2>/dev/null"
docker exec "$name-node" sh -c "printf 'LAN_INTERFACES=%s\nOVERLAY_INTERFACES=%s\n' $lan_if $overlay_if > /etc/default/slax-lan-guard"

guard stop
guard stop
check "stop (twice): no jump, no chain" sh -c "! docker exec $name-node iptables -t mangle -S SLAX-LAN-GUARD >/dev/null 2>&1 && ! docker exec $name-node iptables -t mangle -S PREROUTING | grep -q SLAX"
check "after stop: 22 answers on the overlay again" reach "$name-overlay" "$overlay_ip" 22
check "status after stop: not guarded (non-zero)" sh -c "! docker exec $name-node sh /usr/local/sbin/slax-lan-guard status >/dev/null"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All LAN guard checks passed"
