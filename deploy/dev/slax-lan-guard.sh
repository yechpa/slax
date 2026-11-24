#!/bin/sh
# Keeps the dev cluster NetBird-only: drops TCP 80, 443 (Traefik, through k3s's ServiceLB) and
# 6443 (Kubernetes API) when they arrive on the physical (LAN) interfaces. Traffic on the
# loopback and between pods is untouched, and so is every other LAN port: SSH (22) keeps
# working from the LAN.
#
# On the overlay interfaces (OVERLAY_INTERFACES, NetBird's wt0) it is the other way round:
# only TCP OVERLAY_TCP_PORTS (443, 6443 by default), ICMP and replies to the node's own
# connections pass; everything else is dropped. NetBird's own firewall is disabled on this
# node (`netbird up --disable-firewall`): its ACL marks forwarded traffic and expects the mark
# back unchanged, but k3s's network policy engine (kube-router) sets bits of its own on every
# packet bound for a pod, so NetBird drops whatever ServiceLB redirects to Traefik (443).
# This guard runs in mangle PREROUTING, before Kubernetes' port mappings, so it sees the
# original port and never touches a mark. Keep OVERLAY_TCP_PORTS in line with the NetBird
# policies towards the group slax-dev (deploy/dev/BOOTSTRAP.md §3).
#
# The rules live in a chain of their own, SLAX-LAN-GUARD, in the mangle table (jumped to from
# PREROUTING, so they apply before Kubernetes' port mappings), for IPv4 and, when the host has
# IPv6, IPv6. `start` rebuilds that chain from the current interface list, so it is
# idempotent and an interface removed from the list loses its rule: `start` is also the
# unit's reload.
#
#   slax-lan-guard start|stop|status
#
# Interfaces come from /etc/default/slax-lan-guard (LAN_INTERFACES="enp0s31f6 wlp2s0",
# OVERLAY_INTERFACES="wt0", optionally OVERLAY_TCP_PORTS="443,6443").
# Installed and run by slax-lan-guard.service (deploy/dev/BOOTSTRAP.md, step 4.1).
set -eu

CHAIN=SLAX-LAN-GUARD
PORTS=80,443,6443
LAN_INTERFACES=""
OVERLAY_INTERFACES=""
OVERLAY_TCP_PORTS=443,6443
# shellcheck source=/dev/null
[ ! -r /etc/default/slax-lan-guard ] || . /etc/default/slax-lan-guard
[ -n "$LAN_INTERFACES" ] || { echo "slax-lan-guard: set LAN_INTERFACES in /etc/default/slax-lan-guard" >&2; exit 1; }
for overlay in $OVERLAY_INTERFACES; do
    for interface in $LAN_INTERFACES; do
        [ "$overlay" != "$interface" ] || { echo "slax-lan-guard: $overlay is both a LAN and an overlay interface" >&2; exit 1; }
    done
done

# The rules of one overlay interface, one per line, as arguments after the chain name: replies,
# the allowed ports and ICMP go back to PREROUTING; anything else arriving on it is dropped.
overlay_rules() { # command interface
    icmp=icmp
    [ "$1" = ip6tables ] && icmp=ipv6-icmp
    echo "-i $2 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
    echo "-i $2 -p tcp -m multiport --dports $OVERLAY_TCP_PORTS -j RETURN"
    echo "-i $2 -p $icmp -j RETURN"
    echo "-i $2 -j DROP"
}

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
            for interface in $OVERLAY_INTERFACES; do
                overlay_rules "$cmd" "$interface" | while read -r rule; do
                    # shellcheck disable=SC2086 # the rule is a word list on purpose
                    $cmd -t mangle -A "$CHAIN" $rule
                done
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
            for interface in $OVERLAY_INTERFACES; do
                if $cmd -t mangle -C "$CHAIN" -i "$interface" -j DROP 2>/dev/null; then
                    echo "$cmd: $interface (overlay) guarded (only TCP $OVERLAY_TCP_PORTS and ICMP pass)"
                else
                    echo "$cmd: $interface (overlay) NOT guarded"
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
