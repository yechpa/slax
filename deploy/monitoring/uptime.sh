#!/usr/bin/env bash
# Uptime and disk watch, outside the Laravel app (CronJob slax-monitor, Helm chart
# monitor.enabled; runs every minute in the slax-backup image, docker/backup/Dockerfile).
# It needs nothing from the app, so its alerts still arrive when the app, its queue or its
# Redis are down.
#
# Each run:
#   - every check of MONITOR_CHECKS once: HTTP(S) URLs must answer 2xx (no redirect followed;
#     certificates verified), pg://host:port must accept connections (pg_isready, no password
#     sent), redis://host:port must answer PING (+PONG, or -NOAUTH: alive, no password sent);
#   - after MONITOR_FAIL_THRESHOLD (3) failures in a row: one "DOWN" alert; when it passes
#     again: one "RECOVERED" alert. Nothing in between (no flood), nothing for one or two
#     failures (a pod restarting);
#   - every disk of MONITOR_DISKS (name=path; the filesystem holding that path, as `df` sees
#     it; two paths on one filesystem count once): above MONITOR_DISK_ALERT_PERCENT (80) one
#     alert, repeated at most every MONITOR_DISK_REALERT_SECONDS (6 h) while it stays above;
#     one "back to normal" below MONITOR_DISK_RECOVER_PERCENT (75) (hysteresis: nothing
#     between 75 and 80).
#
# Alerts ("[Prod] ..." / "[Dev] ...", lib.sh) carry only the check's name, the HTTP status or
# a failure class, counts, percentages and a UTC time: never a URL, host, secret or user data.
# The bot token and chat id come from the environment (the Secret's TELEGRAM_BOT_TOKEN and
# TELEGRAM_CHAT_ID) and reach curl only through a config on stdin (lib.sh). An alert that
# cannot be sent is logged (without the token) and retried at the next run: it is recorded as
# sent only once Telegram took it. The script exits 0 whatever the checks say (a failing
# check is not a failing Job); only a configuration error exits non-zero.
#
# State (consecutive failures, what was alerted, when) lives in MONITOR_STATE_FILE, on a
# small volume of its own: it survives pods without any access to the Kubernetes API. The
# file is parsed, never sourced (key=integer lines only), and rewritten in place at a fixed
# size, so saving it needs no new disk block even when the disk is full.
#
# Environment:
#   MONITOR_CHECKS                 required: "name=URL ..." (name: [a-z][a-z0-9-]*)
#   MONITOR_DISKS                  "name=path ..." (none: no disk watch)
#   MONITOR_STATE_FILE             /state/uptime.state
#   MONITOR_FAIL_THRESHOLD         3
#   MONITOR_DISK_ALERT_PERCENT     80
#   MONITOR_DISK_RECOVER_PERCENT   75
#   MONITOR_DISK_REALERT_SECONDS   21600
#   MONITOR_TIMEOUT                10 (seconds per check)
#   PGUSER, PGDATABASE             names pg_isready presents (right names: no log noise)
#   SLAX_ENV_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   alerts (lib.sh)
#   MONITOR_NOW                    tests only: the current time (epoch seconds)
set -uo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh
. "$here/lib.sh"

: "${MONITOR_CHECKS:=}"
: "${MONITOR_DISKS:=}"
: "${MONITOR_STATE_FILE:=/state/uptime.state}"
: "${MONITOR_FAIL_THRESHOLD:=3}"
: "${MONITOR_DISK_ALERT_PERCENT:=80}"
: "${MONITOR_DISK_RECOVER_PERCENT:=75}"
: "${MONITOR_DISK_REALERT_SECONDS:=21600}"
: "${MONITOR_TIMEOUT:=10}"

# The state file's fixed size: room for ~40 entries; a bigger state is written whole.
STATE_SIZE=2048

config_error() {
    log "configuration error: $*"
    exit 2
}

is_count() { [[ "$1" =~ ^[0-9]{1,12}$ ]]; }

for setting in MONITOR_FAIL_THRESHOLD MONITOR_DISK_ALERT_PERCENT MONITOR_DISK_RECOVER_PERCENT MONITOR_DISK_REALERT_SECONDS MONITOR_TIMEOUT; do
    is_count "${!setting}" || config_error "$setting must be a whole number"
done
[ "$MONITOR_FAIL_THRESHOLD" -ge 1 ] || config_error "MONITOR_FAIL_THRESHOLD must be at least 1"
[ "$MONITOR_DISK_RECOVER_PERCENT" -lt "$MONITOR_DISK_ALERT_PERCENT" ] ||
    config_error "MONITOR_DISK_RECOVER_PERCENT must be below MONITOR_DISK_ALERT_PERCENT"
[ -n "$MONITOR_CHECKS" ] || config_error "MONITOR_CHECKS is empty"
now="${MONITOR_NOW:-$(date +%s)}"
is_count "$now" || config_error "MONITOR_NOW must be epoch seconds"

# --- State store: key=integer lines --------------------------------------------------------

declare -A state=() next=()

# state_load FILE: into `state`. A missing file is an empty state; malformed lines are
# ignored (and counted), never evaluated.
state_load() {
    local file="$1" line bad=0
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        [ -n "$line" ] || continue
        if [[ "$line" =~ ^([a-z][a-z0-9.-]{0,63})=([0-9]{1,12})$ ]]; then
            state["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
        else
            bad=$((bad + 1))
        fi
    done < "$file"
    [ "$bad" -eq 0 ] || log "WARNING: $bad malformed line(s) in the state file ignored."
}

# state_render: `next` as sorted key=value lines.
state_render() {
    local key
    for key in "${!next[@]}"; do printf '%s=%s\n' "$key" "${next[$key]}"; done | sort
}

# state_save FILE: `next`, padded with newlines to STATE_SIZE bytes and written over the
# existing file without truncating it (no block to allocate: works on a full disk). A new or
# too small file is written beside it and renamed. Returns non-zero if it could not be saved.
state_save() {
    local file="$1" content size pad
    content="$(state_render)"$'\n'
    if [ "${#content}" -lt "$STATE_SIZE" ]; then
        printf -v pad '%*s' $((STATE_SIZE - ${#content})) ''
        content="${content}${pad// /$'\n'}"
    fi
    size=0
    [ ! -f "$file" ] || size="$(wc -c 2> /dev/null < "$file" || echo 0)"
    if [ "$size" -eq "${#content}" ]; then
        printf '%s' "$content" 1<> "$file" && return 0
    fi
    printf '%s' "$content" > "$file.new" && mv -f "$file.new" "$file"
}

# get KEY [DEFAULT]: a value of the loaded state.
get() { printf '%s' "${state[$1]:-${2:-0}}"; }

utc_time() { date -u -d "@$1" +%H:%M 2> /dev/null || echo "?"; }

# --- Checks ---------------------------------------------------------------------------------

# probe SPEC: sets `ok` (0/1) and `detail` (HTTP status or failure class: no host, no URL).
probe() {
    local spec="$1" code rc hostport host port reply
    ok=0
    detail=""
    case "$spec" in
        http://* | https://*)
            code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
                --proto '=http,https' --connect-timeout 5 --max-time "$MONITOR_TIMEOUT" \
                --user-agent slax-uptime "$spec" 2> /dev/null)" && rc=0 || rc=$?
            if [ "$rc" -eq 0 ]; then
                detail="HTTP $code"
                [[ "$code" =~ ^2[0-9][0-9]$ ]] && ok=1
                return 0
            fi
            case "$rc" in
                6) detail="DNS failure" ;;
                7) detail="connection refused" ;;
                28) detail="timeout" ;;
                35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 83 | 90 | 91) detail="TLS error" ;;
                52) detail="empty reply" ;;
                56) detail="connection reset" ;;
                *) detail="error (curl $rc)" ;;
            esac
            ;;
        pg://*)
            hostport="${spec#pg://}"
            host="${hostport%:*}"
            port="${hostport##*:}"
            pg_isready -q -h "$host" -p "$port" -t "$MONITOR_TIMEOUT" > /dev/null 2>&1 && rc=0 || rc=$?
            case "$rc" in
                0) ok=1 detail="accepting connections" ;;
                1) detail="rejecting connections" ;;
                2) detail="no answer" ;;
                *) detail="error (pg_isready $rc)" ;;
            esac
            ;;
        redis://*)
            hostport="${spec#redis://}"
            host="${hostport%:*}"
            port="${hostport##*:}"
            # One PING on a plain TCP connection. Without the password Redis answers -NOAUTH,
            # which proves it is up just as well as +PONG.
            # shellcheck disable=SC2016 # expanded by the inner bash
            reply="$(timeout "$MONITOR_TIMEOUT" bash -c \
                'exec 3<> "/dev/tcp/$1/$2" || exit 2; printf "PING\r\n" >&3; IFS= read -r -t 5 line <&3 || exit 3; printf "%s" "$line"' \
                _ "$host" "$port" 2> /dev/null)" && rc=0 || rc=$?
            if [ "$rc" -eq 0 ]; then
                case "${reply%$'\r'}" in
                    +PONG | -NOAUTH*) ok=1 detail="answering" ;;
                    *) detail="unexpected reply" ;;
                esac
            elif [ "$rc" -eq 3 ]; then
                detail="no reply"
            elif [ "$rc" -eq 124 ] || [ "$rc" -eq 143 ]; then
                detail="timeout"
            else
                detail="no answer"
            fi
            ;;
    esac
}

summary=()

# check NAME SPEC
check() {
    local name="$1" spec="$2" fails down since minutes k
    k="check.$name"
    fails="$(get "$k.fails")"
    down="$(get "$k.down")"
    since="$(get "$k.since")"
    probe "$spec"
    if [ "$ok" -eq 1 ]; then
        summary+=("$name=ok")
        if [ "$down" -eq 1 ]; then
            minutes="?"
            [ "$since" -eq 0 ] || minutes=$(((now - since + 59) / 60))
            if telegram_send "RECOVERED: ${name} is answering again (${detail}) after about ${minutes} min down (${fails} failed checks)."; then
                down=0
            fi
        fi
        if [ "$down" -eq 0 ]; then fails=0 since=0; fi
    else
        summary+=("$name=FAIL($detail)")
        fails=$((fails + 1))
        [ "$fails" -gt 1 ] && [ "$since" -ne 0 ] || since="$now"
        if [ "$fails" -ge "$MONITOR_FAIL_THRESHOLD" ] && [ "$down" -eq 0 ]; then
            if telegram_send "DOWN: ${name} failed ${fails} checks in a row (${detail}), since $(utc_time "$since") UTC."; then
                down=1
            fi
        fi
    fi
    next["$k.fails"]="$fails"
    next["$k.down"]="$down"
    next["$k.since"]="$since"
}

# disk NAME PATH
declare -A filesystems=()
disk() {
    local name="$1" path="$2" fs total used avail percent alerted last k
    k="disk.$name"
    if ! read -r fs total used avail < <(df -Pk "$path" 2> /dev/null | awk 'NR == 2 { print $1, $2, $3, $4 }') ||
        ! is_count "$total" || ! is_count "$used" || ! is_count "$avail" || [ $((used + avail)) -eq 0 ]; then
        summary+=("disk:$name=unknown")
        log "WARNING: cannot read the usage of disk \"$name\"."
        return 0
    fi
    if [ -n "${filesystems["$fs:$total"]:-}" ]; then
        summary+=("disk:$name=same-as-${filesystems["$fs:$total"]}")
        return 0
    fi
    filesystems["$fs:$total"]="$name"
    # As df rounds it: used / (used + available to unprivileged users), rounded up.
    percent=$(((used * 100 + used + avail - 1) / (used + avail)))
    summary+=("disk:$name=${percent}%")
    alerted="$(get "$k.alerted")"
    last="$(get "$k.last")"
    if [ "$percent" -gt "$MONITOR_DISK_ALERT_PERCENT" ]; then
        if [ "$alerted" -eq 0 ] || [ $((now - last)) -ge "$MONITOR_DISK_REALERT_SECONDS" ]; then
            if telegram_send "DISK: ${name} disk ${percent}% full (alert above ${MONITOR_DISK_ALERT_PERCENT}%). Reminder every $((MONITOR_DISK_REALERT_SECONDS / 3600)) h while above; all clear below ${MONITOR_DISK_RECOVER_PERCENT}%."; then
                alerted=1 last="$now"
            fi
        fi
    elif [ "$percent" -lt "$MONITOR_DISK_RECOVER_PERCENT" ] && [ "$alerted" -eq 1 ]; then
        if telegram_send "DISK OK: ${name} disk back to ${percent}% (below ${MONITOR_DISK_RECOVER_PERCENT}%)."; then
            alerted=0 last=0
        fi
    fi
    next["$k.alerted"]="$alerted"
    next["$k.last"]="$last"
}

# --- Run ------------------------------------------------------------------------------------

# entries LIST VARIABLE VALUE_PATTERN: the list's name=value entries, one per line; names are
# safe as state keys and in messages.
entries() {
    local entry
    for entry in $1; do
        [[ "$entry" =~ ^[a-z][a-z0-9-]{0,30}=(.+)$ ]] && [[ "${BASH_REMATCH[1]}" =~ $3 ]] ||
            config_error "bad entry in $2 (expected name=value, name [a-z][a-z0-9-]*, value $3)"
        printf '%s\n' "$entry"
    done
}

checks="$(entries "$MONITOR_CHECKS" MONITOR_CHECKS '^(https?://[^[:space:]]+|(pg|redis)://[a-zA-Z0-9.-]+:[0-9]{1,5})$')" || exit 2
disks="$(entries "$MONITOR_DISKS" MONITOR_DISKS '^/[^[:space:]]*$')" || exit 2

state_load "$MONITOR_STATE_FILE"

while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    check "${entry%%=*}" "${entry#*=}"
done <<< "$checks"

while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    disk "${entry%%=*}" "${entry#*=}"
done <<< "$disks"

if ! state_save "$MONITOR_STATE_FILE"; then
    log "WARNING: the state could not be saved to $MONITOR_STATE_FILE: the next run starts from the previous state."
fi
log "uptime: ${summary[*]}"
exit 0
