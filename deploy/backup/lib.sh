# shellcheck shell=bash
# Shared by pg-backup.sh and restore-check.sh (sourced, not run).
#
# Telegram alerts: "[<SLAX_ENV_LABEL>] <text>", plain text, never a secret or a command's
# output (only fixed wording, the step that failed, names and counts). The bot token and the
# chat id come from the environment only (the Secret's TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)
# and never reach a command line: curl reads the URL and the chat id from a config on stdin.
# Without them, alerts are printed only. TELEGRAM_API_URL exists for the local test (a fake
# Telegram); production uses the default.

: "${SLAX_ENV_LABEL:=Prod}"
: "${TELEGRAM_API_URL:=https://api.telegram.org}"

log() {
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# alert TEXT: send "[label] TEXT" to the administrators' Telegram chat. Never fails the caller.
alert() {
    local text="[${SLAX_ENV_LABEL}] $1"
    log "alert: $text"
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
        log "Telegram is not configured: alert not sent."
        return 0
    fi
    if printf '%s\n' \
        "url = \"${TELEGRAM_API_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage\"" \
        "data-urlencode = \"chat_id=${TELEGRAM_CHAT_ID}\"" |
        curl --silent --fail --max-time 15 --output /dev/null --config - \
            --data-urlencode "text=${text}" \
            --data-urlencode "disable_web_page_preview=true"; then
        log "alert sent."
    else
        log "the Telegram alert could not be sent (curl exit $?)."
    fi
    return 0
}

# require NAME...: every named variable must be set and non-empty.
require() {
    local name
    for name in "$@"; do
        if [ -z "${!name:-}" ]; then
            log "missing environment variable: $name"
            return 1
        fi
    done
}

# human BYTES: a short size for messages.
human() {
    awk -v b="$1" 'BEGIN { split("B KB MB GB", u); i = 1; while (b >= 1024 && i < 4) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# SIGTERM (the Job's activeDeadlineSeconds, an eviction, a node drain) must not kill a script
# silently. bash runs as PID 1 in the pod and would only run a trap once the current command
# ends; so long commands run through `run`, in the background, and the trap fires at once:
# it stops the child, records the termination (the scripts' EXIT trap alerts) and exits 143.
child=""
# shellcheck disable=SC2034 # read by the scripts' EXIT traps
terminated=""
on_term() {
    trap - TERM INT
    # shellcheck disable=SC2034 # read by the scripts' EXIT traps
    terminated=1
    [ -z "$child" ] || kill -TERM "$child" 2>/dev/null || true
    log "terminated by a signal"
    exit 143
}
trap on_term TERM INT

# run COMMAND...: COMMAND in the background, waited for (interruptible by SIGTERM).
run() {
    local status
    "$@" &
    child=$!
    if wait "$child"; then status=0; else status=$?; fi
    child=""
    return "$status"
}

# aws_error_class FILE: the class of an AWS CLI error (never its message): AccessDenied,
# NoSuchBucket, network, credentials, ... or "error".
aws_error_class() {
    local class
    class="$(grep -oE 'AccessDenied|NoSuchBucket|NoSuchKey|InvalidAccessKeyId|ExpiredToken|SignatureDoesNotMatch|SlowDown|InternalError|Could not connect|Connect timeout|Read timeout|Unable to locate credentials' "$1" 2>/dev/null | head -n 1 || true)"
    case "$class" in
        "Could not connect" | "Connect timeout" | "Read timeout") echo network ;;
        "Unable to locate credentials") echo no-credentials ;;
        "") echo error ;;
        *) echo "$class" ;;
    esac
}
