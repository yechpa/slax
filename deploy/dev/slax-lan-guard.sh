#!/bin/sh
# Keeps the dev cluster tailnet-only: drops TCP 80, 443 (Traefik, through k3s's ServiceLB) and
# 6443 (Kubernetes API) when they arrive on the physical (LAN) interfaces. Traffic on
# tailscale0, on the loopback and between pods is untouched, and so is every other port: SSH
# (22) keeps working from the LAN and the tailnet.
#
# The rules live in a chain of their own, SLAX-LAN-GUARD, in the mangle table (jumped to from
# PREROUTING, so they apply before Kubernetes' port mappings), for IPv4 and, when the host has
# IPv6, IPv6. `start` rebuilds that chain from the current interface list, so it is
# idempotent and an interface removed from the list loses its rule: `start` is also the
# unit's reload.
#
#   slax-lan-guard start|stop|status
#
# Interfaces come from /etc/default/slax-lan-guard (LAN_INTERFACES="enp0s31f6 wlp2s0").
# Installed and run by slax-lan-guard.service (deploy/dev/BOOTSTRAP.md, step 4.1).
set -eu

CHAIN=SLAX-LAN-GUARD
PORTS=80,443,6443
LAN_INTERFACES=""
# shellcheck source=/dev/null
[ ! -r /etc/default/slax-lan-guard ] || . /etc/default/slax-lan-guard
[ -n "$LAN_INTERFACES" ] || { echo "slax-lan-guard: set LAN_INTERFACES in /etc/default/slax-lan-guard" >&2; exit 1; }

# iptables, and ip6tables when the host has IPv6 and its mangle table is usable.
families() {
    echo iptables
    if [ -e /proc/net/if_inet6 ] && ip6tables -t mangle -S >/dev/null 2>&1; then
        echo ip6tables
    fi
}

case "${1:-}" in
    start)
        for cmd in $(families); do
            $cmd -t mangle -N "$CHAIN" 2>/dev/null || true
            $cmd -t mangle -F "$CHAIN"
            for interface in $LAN_INTERFACES; do
                $cmd -t mangle -A "$CHAIN" -i "$interface" -p tcp -m multiport --dports "$PORTS" -j DROP
            done
            $cmd -t mangle -C PREROUTING -j "$CHAIN" 2>/dev/null || $cmd -t mangle -I PREROUTING -j "$CHAIN"
        done
        ;;
    stop)
        for cmd in iptables ip6tables; do
            command -v "$cmd" >/dev/null || continue
            while $cmd -t mangle -C PREROUTING -j "$CHAIN" 2>/dev/null; do
                $cmd -t mangle -D PREROUTING -j "$CHAIN"
            done
            if $cmd -t mangle -S "$CHAIN" >/dev/null 2>&1; then
                $cmd -t mangle -F "$CHAIN"
                $cmd -t mangle -X "$CHAIN"
            fi
        done
        ;;
    status)
        missing=0
        for cmd in $(families); do
            if ! $cmd -t mangle -C PREROUTING -j "$CHAIN" 2>/dev/null; then
                echo "$cmd: NOT guarded (no jump to $CHAIN)"
                missing=1
                continue
            fi
            for interface in $LAN_INTERFACES; do
                if $cmd -t mangle -C "$CHAIN" -i "$interface" -p tcp -m multiport --dports "$PORTS" -j DROP 2>/dev/null; then
                    echo "$cmd: $interface guarded ($PORTS dropped)"
                else
                    echo "$cmd: $interface NOT guarded"
                    missing=1
                fi
            done
        done
        exit "$missing"
        ;;
    *)
        echo "usage: $0 start|stop|status" >&2
        exit 2
        ;;
esac
