#!/usr/bin/env bash
# Nightly care of the dev server (slax-dev), run by slax-dev-care.timer as root: install the
# Ubuntu updates, then check that everything Slax stands on still works, and send one
# Telegram message with the result ("[Dev] ..."). Installed by deploy/dev/BOOTSTRAP.md,
# step 16.
#
#   slax-dev-care            the full run (what the timer does)
#   slax-dev-care --check    the checks only, nothing is installed (also sends the report)
#
# What it does NOT do: reboot. A pending reboot is reported ("reboot needed") and waits for
# you: the dev disk, the LAN guard and k3s must come back together, and a person should be
# there to see that they did (BOOTSTRAP.md step 4.1 and the troubleshooting table).
#
# The message carries package names, service names, counts and percentages: never a URL, a
# secret or user data. The bot token and chat id come from the environment (the timer's
# EnvironmentFile /etc/slax-dev-care.env, root only) and never reach a command line (lib.sh).
# A failing step does not stop the run: every check is made, the message says what failed.
# Exit status: 0 when every check passed, 1 otherwise (the unit shows "failed").
set -u -o pipefail

LIB="${SLAX_CARE_LIB:-/usr/local/lib/slax-dev-care/lib.sh}"
SLAX_ENV_LABEL=Dev
# shellcheck source-path=SCRIPTDIR source=../backup/lib.sh
. "$LIB" || { echo "slax-dev-care: cannot read $LIB" >&2; exit 2; }

: "${DEV_HOST:=dev.slax.yechpa.com}"
: "${KUBECTL:=k3s kubectl}"
: "${NAMESPACE:=slax}"
: "${DISK_ALERT_PERCENT:=80}"
: "${DISK_PATHS:=/ /mnt/ssd}"

MODE=full
case "${1:-}" in
    '') ;;
    --check) MODE=check ;;
    *) echo "usage: slax-dev-care [--check]" >&2; exit 2 ;;
esac

lines=()
problems=0
ok() { lines+=("✅ $1"); }
info() { lines+=("ℹ️ $1"); }
bad() { lines+=("❌ $1"); problems=$((problems + 1)); }

# --- 1. Updates ----------------------------------------------------------------------------
# "Upgradable" is read before and the installed versions after: the report names what really
# changed. Configuration files you edited are kept (force-confold); no question is ever asked.
upgrade() {
    local before after changed
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    if ! apt-get update -qq >/dev/null 2>&1; then
        bad "apt update failed (network or mirror)"
        return
    fi
    before=$(dpkg-query -W -f '${Package} ${Version}\n' | sort)
    if ! apt-get -y -qq -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef \
        upgrade >/dev/null 2>&1; then
        bad "apt upgrade failed: run it by hand to see why"
        return
    fi
    apt-get -y -qq autoremove >/dev/null 2>&1 || true
    after=$(dpkg-query -W -f '${Package} ${Version}\n' | sort)
    changed=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | cut -d' ' -f1 | sort -u)
    if [ -z "$changed" ]; then
        ok "system up to date, nothing to install"
    else
        local count names
        count=$(printf '%s\n' "$changed" | wc -l)
        names=$(printf '%s\n' "$changed" | head -n 12 | paste -sd' ')
        [ "$count" -le 12 ] || names="$names ... ($count in all)"
        ok "updates installed: $names"
    fi
}

if [ "$MODE" = full ]; then upgrade; fi

if [ -e /var/run/reboot-required ]; then
    info "reboot needed (kernel or core library updated): do it when you can, then check step 4.1"
else
    ok "no reboot needed"
fi

# --- 2. Services ---------------------------------------------------------------------------
for unit in k3s tailscaled slax-lan-guard; do
    if systemctl is-active --quiet "$unit"; then ok "$unit running"; else bad "$unit is NOT running"; fi
done

# --- 3. The cluster and the app ------------------------------------------------------------
# shellcheck disable=SC2086 # KUBECTL is a command with its first argument ("k3s kubectl")
kube() { timeout 20 $KUBECTL "$@" 2>/dev/null; }

if nodes=$(kube get nodes --no-headers) && [ -n "$nodes" ]; then
    notready=$(printf '%s\n' "$nodes" | awk '$2 != "Ready"' | wc -l)
    if [ "$notready" -eq 0 ]; then ok "node Ready"; else bad "node not Ready"; fi
else
    bad "the cluster does not answer"
fi

if pods=$(kube -n "$NAMESPACE" get pods --no-headers) && [ -n "$pods" ]; then
    total=$(printf '%s\n' "$pods" | wc -l)
    unhealthy=$(printf '%s\n' "$pods" | awk '$3 != "Running" && $3 != "Completed"' | wc -l)
    if [ "$unhealthy" -eq 0 ]; then ok "slax pods: $total, all running"; else bad "slax pods: $unhealthy of $total not running"; fi
else
    bad "no slax pods found"
fi

# The app, as a person on the tailnet reaches it. 200 only: a redirect or an error is a failure.
status=$(curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' "https://${DEV_HOST}/healthz" || true)
if [ "$status" = 200 ]; then ok "slax answers (200)"; else bad "slax answers ${status:-nothing} instead of 200"; fi

# --- 4. Tailscale and the certificate ------------------------------------------------------
if tailscale status >/dev/null 2>&1; then ok "Tailscale connected"; else bad "Tailscale not connected"; fi

expiry=$(printf '' | timeout 10 openssl s_client -connect "${DEV_HOST}:443" -servername "$DEV_HOST" 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$expiry" ]; then
    days=$(( ($(date -d "$expiry" +%s) - $(date +%s)) / 86400 ))
    if [ "$days" -ge 14 ]; then ok "certificate valid for $days more days"; else bad "certificate expires in $days days (cert-manager should have renewed it)"; fi
else
    bad "certificate not readable"
fi

# --- 5. Disks ------------------------------------------------------------------------------
for path in $DISK_PATHS; do
    [ -e "$path" ] || continue
    used=$(df --output=pcent "$path" | tail -n 1 | tr -dc '0-9')
    if [ -z "$used" ]; then bad "disk $path unreadable"; continue; fi
    if [ "$used" -ge "$DISK_ALERT_PERCENT" ]; then bad "disk $path ${used}% used"; else info "disk $path ${used}% used"; fi
done

# --- Report --------------------------------------------------------------------------------
if [ "$problems" -eq 0 ]; then head="Server care done, everything works."; else head="Server care done, $problems problem(s)."; fi
report="$head"
for line in "${lines[@]}"; do report="${report}"$'\n'"${line}"; done
telegram_send "$report" || true
[ "$problems" -eq 0 ]
