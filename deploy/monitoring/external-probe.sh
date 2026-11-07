#!/usr/bin/env bash
# One outside check of a public health URL, run by .github/workflows/external-probe.yml from
# GitHub's runners: neither Slax cluster is involved, so it still speaks when a node is dead,
# switched off, or cut from the Internet (the in-cluster monitor, uptime.sh, sends nothing then).
#
# It is uptime.sh with a single check named "external" (same thresholds logic, same wording,
# same Telegram path: a "DOWN" after PROBE_FAIL_THRESHOLD failures in a row, one "RECOVERED",
# nothing in between, never a URL or a secret in a message). A runner has no disk of its own to
# keep the failure count, so the workflow restores and saves PROBE_STATE_DIR with the Actions
# cache between runs.
#
#   external-probe.sh <Dev|Prod> <health URL>
#
# Environment:
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   alerts (lib.sh); none: printed only
#   PROBE_STATE_DIR                        where the state file lives (default: a new temp dir)
#   PROBE_FAIL_THRESHOLD                   failures in a row before "DOWN" (2: with a run every
#                                          5 minutes, an alert comes after 5 to 15 minutes)
#   MONITOR_NOW, TELEGRAM_API_URL          tests only (uptime.sh, lib.sh)
# Exits 0 whatever the check says (like uptime.sh); non-zero only for a wrong invocation.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
label="${1:-}"
url="${2:-}"
case "$label" in
    Dev | Prod) ;;
    *)
        echo "usage: $0 <Dev|Prod> <health URL>" >&2
        exit 2
        ;;
esac
case "$url" in
    https://* | http://*) ;;
    *)
        echo "usage: $0 <Dev|Prod> <health URL>" >&2
        exit 2
        ;;
esac

state_dir="${PROBE_STATE_DIR:-$(mktemp -d)}"
mkdir -p "$state_dir"

# uptime.sh sources lib.sh from its own directory, as the image lays them out.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$here/uptime.sh" "$here/../backup/lib.sh" "$stage/"

status=0
SLAX_ENV_LABEL="$label" \
    MONITOR_CHECKS="external=$url" \
    MONITOR_STATE_FILE="$state_dir/uptime.state" \
    MONITOR_FAIL_THRESHOLD="${PROBE_FAIL_THRESHOLD:-2}" \
    MONITOR_TIMEOUT=10 MONITOR_TELEGRAM_TIMEOUT=10 MONITOR_BUDGET_SECONDS=40 \
    bash "$stage/uptime.sh" || status=$?
exit "$status"
