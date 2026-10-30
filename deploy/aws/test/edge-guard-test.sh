#!/usr/bin/env bash
# deploy/aws/slax-edge-guard.sh in a throwaway container standing in for the node (its eth0,
# the default route, plays the public interface): make edge-guard-test.
#
# Checks: start is idempotent (one jump, the expected rules, nothing about 80/443); from
# another container, 6443/9345/10250/22 time out while 80 and 443 still answer; traffic on another
# interface (the loopback) is untouched; status reports; stop removes everything and is
# harmless twice; tailscale0/cni0 named as public interfaces are refused.
set -euo pipefail

alpine_image="alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
name="slax-edge-guard-test-$$"

cleanup() {
    docker rm -f "$name-node" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}

docker network create "$name" >/dev/null
# The "node": iptables, and listeners on the ports that matter.
docker run -d --name "$name-node" --network "$name" --cap-add NET_ADMIN \
    -v "$repo/deploy/aws/slax-edge-guard.sh:/usr/local/sbin/slax-edge-guard:ro" "$alpine_image" \
    sh -c 'apk add -q --no-cache iptables ip6tables iproute2 >/dev/null && touch /ready \
        && for p in 22 80 443 6443 9345 10250; do (while true; do echo ok | nc -l -p $p >/dev/null 2>&1; done) & done; sleep 3600' >/dev/null
for _ in $(seq 1 60); do docker exec "$name-node" test -e /ready 2>/dev/null && break; sleep 1; done
node_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$name\").IPAddress}}" "$name-node")"
guard() { docker exec "$name-node" sh /usr/local/sbin/slax-edge-guard "$@"; }
# reach PORT: does a TCP connection from another container answer within 3 s?
reach() { docker run --rm --network "$name" "$alpine_image" sh -c "echo | nc -w 3 $node_ip $1 | grep -q ok"; }
unreachable() { ! reach "$1"; }

check "before the guard: 6443 answers (the test can see a drop)" reach 6443

guard start
guard start
rules="$(docker exec "$name-node" iptables -t mangle -S SLAX-EDGE-GUARD)"
check "start twice: one jump from PREROUTING" test "$(docker exec "$name-node" iptables -t mangle -S PREROUTING | grep -c 'SLAX-EDGE-GUARD')" = 1
check "... rules on the default route's interface (eth0) only" \
    test "$(printf '%s\n' "$rules" | grep -c -- '-A SLAX-EDGE-GUARD -i eth0 ')" = 2
check "... TCP 22, 6443, 9345, 10250, 10256 and UDP 8472 dropped" \
    sh -c "printf '%s\n' \"\$1\" | grep -q 'tcp.*--dports 22,6443,9345,10250,10256 -j DROP' && printf '%s\n' \"\$1\" | grep -q 'udp.*--dports 8472 -j DROP'" _ "$rules"
check "... nothing about 80 or 443" sh -c "! printf '%s\n' \"\$1\" | grep -qE '(^|[ ,])(80|443)([ ,]|$)'" _ "$rules"

check "guarded: 6443 times out from outside" unreachable 6443
check "guarded: 9345 (extra supervisor/RKE2 port, defence in depth) times out from outside" unreachable 9345
check "guarded: 10250 times out from outside" unreachable 10250
check "guarded: 22 times out from outside" unreachable 22
check "Caddy's 443 still answers" reach 443
check "Caddy's 80 still answers" reach 80
check "the node itself (loopback) still reaches 6443" docker exec "$name-node" sh -c 'echo | nc -w 3 127.0.0.1 6443 | grep -q ok'
check "status: guarded" sh -c "docker exec $name-node sh /usr/local/sbin/slax-edge-guard status | grep -q 'eth0 guarded'"

guard stop
guard stop
check "stop (twice): no jump, no chain" sh -c "! docker exec $name-node iptables -t mangle -S SLAX-EDGE-GUARD >/dev/null 2>&1 && ! docker exec $name-node iptables -t mangle -S PREROUTING | grep -q SLAX"
check "after stop: 6443 answers again" reach 6443
check "status after stop: not guarded (non-zero)" sh -c "! docker exec $name-node sh /usr/local/sbin/slax-edge-guard status >/dev/null"

echo "== boot: the default route comes late"
gateway="$(docker exec "$name-node" ip -4 route show default | awk '{print $3; exit}')"
docker exec "$name-node" ip route del default
docker exec -e SLAX_EDGE_GUARD_ROUTE_WAIT=20 "$name-node" sh /usr/local/sbin/slax-edge-guard start > /dev/null 2>&1 &
late=$!
sleep 4
docker exec "$name-node" ip route add default via "$gateway"
if wait "$late"; then late_status=0; else late_status=$?; fi
check "start waits for a default route that appears late, then guards" test "$late_status" = 0
check "... on that route's interface" sh -c "docker exec $name-node iptables -t mangle -S SLAX-EDGE-GUARD | grep -q -- '-i eth0 '"
guard stop
docker exec "$name-node" ip route del default
started="$(date +%s)"
if out="$(docker exec -e SLAX_EDGE_GUARD_ROUTE_WAIT=3 "$name-node" sh /usr/local/sbin/slax-edge-guard start 2>&1)"; then status=0; else status=$?; fi
check "no default route at all: start fails after the wait (systemd retries it)" \
    sh -c "test $status != 0 && test $(($(date +%s) - started)) -ge 3 && printf '%s' \"\$1\" | grep -q 'no default route after 3 s'" _ "$out"
check "... and stop still works without a route" docker exec "$name-node" sh /usr/local/sbin/slax-edge-guard stop
docker exec "$name-node" ip route add default via "$gateway"

for bad in tailscale0 cni0 lo; do
    check "refuses $bad as a public interface" sh -c "! docker exec -e PUBLIC_INTERFACES=$bad $name-node sh -c 'mkdir -p /etc/default && echo PUBLIC_INTERFACES=$bad > /etc/default/slax-edge-guard && sh /usr/local/sbin/slax-edge-guard start' 2>/dev/null"
done
docker exec "$name-node" rm -f /etc/default/slax-edge-guard

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All edge guard checks passed"
