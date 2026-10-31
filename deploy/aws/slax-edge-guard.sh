#!/bin/sh
# Second line of defence behind the security group on the production node: drops what k3s
# (and SSH) would answer on the public interface even if the security group were opened by
# mistake. TCP 22 (SSH; sshd is off anyway), 6443 (Kubernetes API, also k3s's supervisor),
# 9345 (an extra supervisor port: RKE2's, unused by k3s, closed as defence in depth), 10250
# (kubelet), 10256 (kube-proxy health) and UDP 8472 (flannel VXLAN) arriving on the public
# interface are dropped. Nothing else is touched: Caddy's 80/443, tailscale0 (kubectl and CI come that way),
# the loopback, the pod network (cni0, flannel.1) and everything the node sends.
#
# The rules live in a chain of their own, SLAX-EDGE-GUARD, in the mangle table (jumped to from
# PREROUTING, before any Kubernetes rule), for IPv4 and, when usable, IPv6. `start` rebuilds
# the chain, so it is idempotent; it is also the unit's reload. Same design as the dev LAN
# guard (deploy/dev/slax-lan-guard.sh).
#
#   slax-edge-guard start|stop|status
#
# The public interface is the one of the default route (ens5 on EC2), unless
# /etc/default/slax-edge-guard sets PUBLIC_INTERFACES="...". Installed by
# deploy/aws/cloud-init.yaml (unit slax-edge-guard.service, started before k3s).
set -eu

CHAIN=SLAX-EDGE-GUARD
TCP_PORTS=22,6443,9345,10250,10256
UDP_PORTS=8472
PUBLIC_INTERFACES=""
# shellcheck source=/dev/null
[ ! -r /etc/default/slax-edge-guard ] || . /etc/default/slax-edge-guard
default_interface() {
    ip -o -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
}
# At boot the default route may come a little after this unit starts: wait for it (up to
# SLAX_EDGE_GUARD_ROUTE_WAIT seconds, 60 by default) before giving up. Only `start` needs it.
if [ -z "$PUBLIC_INTERFACES" ] && [ "${1:-}" != stop ]; then
    waited=0
    while :; do
        PUBLIC_INTERFACES="$(default_interface)"
        [ -z "$PUBLIC_INTERFACES" ] || break
        [ "$waited" -lt "${SLAX_EDGE_GUARD_ROUTE_WAIT:-60}" ] || break
        sleep 1
        waited=$((waited + 1))
    done
    [ -n "$PUBLIC_INTERFACES" ] || { echo "slax-edge-guard: no default route after ${waited} s: set PUBLIC_INTERFACES in /etc/default/slax-edge-guard" >&2; exit 1; }
fi
for interface in $PUBLIC_INTERFACES; do
    case "$interface" in
        lo | tailscale* | cni* | flannel* | veth* | docker* | br-*)
            echo "slax-edge-guard: $interface is not a public interface: refusing" >&2
            exit 1
            ;;
    esac
done

families() {
    echo iptables
    if [ -e /proc/net/if_inet6 ] && ip6tables -t mangle -S >/dev/null 2>&1; then
        echo ip6tables
    fi
}

rules() { # the rules of one interface, as iptables arguments after the chain name
    echo "-i $1 -p tcp -m multiport --dports $TCP_PORTS -j DROP"
    echo "-i $1 -p udp -m multiport --dports $UDP_PORTS -j DROP"
}

case "${1:-}" in
    start)
        for cmd in $(families); do
            $cmd -t mangle -N "$CHAIN" 2>/dev/null || true
            $cmd -t mangle -F "$CHAIN"
            for interface in $PUBLIC_INTERFACES; do
                rules "$interface" | while read -r rule; do
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
            for interface in $PUBLIC_INTERFACES; do
                if rules "$interface" | while read -r rule; do
                    # shellcheck disable=SC2086
                    $cmd -t mangle -C "$CHAIN" $rule 2>/dev/null || exit 1
                done; then
                    echo "$cmd: $interface guarded (tcp $TCP_PORTS, udp $UDP_PORTS dropped)"
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
