#!/bin/sh
# Keeps the dev cluster tailnet-only: drops TCP 80, 443 (Traefik, through k3s's ServiceLB) and
# 6443 (Kubernetes API) when they arrive on the physical (LAN) interfaces. Traffic on
# tailscale0, on the loopback and between pods is untouched, and so is every other port: SSH
# (22) keeps working from the LAN and the tailnet. Rules go in the mangle table's PREROUTING,
# so they apply before Kubernetes' port mappings, for IPv4 and IPv6.
#
#   slax-lan-guard start|stop|status
#
# Interfaces come from /etc/default/slax-lan-guard (LAN_INTERFACES="enp0s31f6 wlp2s0").
# Installed and run by slax-lan-guard.service (deploy/dev/BOOTSTRAP.md, step 4). To undo it
# from the machine's console: sudo systemctl disable --now slax-lan-guard
set -eu

PORTS=80,443,6443
LAN_INTERFACES=""
[ ! -r /etc/default/slax-lan-guard ] || . /etc/default/slax-lan-guard
[ -n "$LAN_INTERFACES" ] || { echo "slax-lan-guard: set LAN_INTERFACES in /etc/default/slax-lan-guard" >&2; exit 1; }

rule() { # interface -> the rule's arguments
    echo "-i $1 -p tcp -m multiport --dports $PORTS -j DROP"
}

case "${1:-}" in
    start)
        for cmd in iptables ip6tables; do
            for interface in $LAN_INTERFACES; do
                # shellcheck disable=SC2046
                $cmd -t mangle -C PREROUTING $(rule "$interface") 2>/dev/null \
                    || $cmd -t mangle -I PREROUTING $(rule "$interface")
            done
        done
        ;;
    stop)
        for cmd in iptables ip6tables; do
            for interface in $LAN_INTERFACES; do
                # shellcheck disable=SC2046
                while $cmd -t mangle -C PREROUTING $(rule "$interface") 2>/dev/null; do
                    $cmd -t mangle -D PREROUTING $(rule "$interface")
                done
            done
        done
        ;;
    status)
        missing=0
        for cmd in iptables ip6tables; do
            for interface in $LAN_INTERFACES; do
                # shellcheck disable=SC2046
                if $cmd -t mangle -C PREROUTING $(rule "$interface") 2>/dev/null; then
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
