#!/usr/bin/env bash
# The uptime monitor (deploy/monitoring/uptime.sh) against throwaway services, in containers
# (make monitor-test):
#   - a fake health endpoint whose answer the test sets (fake-target.py: a status code, a
#     hang, a closed connection);
#   - PostgreSQL 16 and Redis 7 (with a password), as in the chart;
#   - a size-limited tmpfs volume as the watched disk, filled by the test;
#   - a fake Telegram (deploy/backup/test/telegram-sink.py) recording every alert.
# The script runs in the slax-backup image as in the cluster: uid 70, read-only root
# filesystem, no capability, its state on a mounted directory (the CronJob's volume). The
# clock is set per run (MONITOR_NOW) so reminders 6 hours apart take no time.
#
#   deploy/monitoring/test/monitor-test.sh <slax-backup image>
#
# Checks: 2 failures say nothing, the 3rd one alert, more failures nothing more, the
# recovery one message; a Telegram outage delays alerts without losing or repeating them;
# disk above 80 % one alert, a reminder after 6 h only, nothing between 75 and 80 %, one
# all-clear below 75 %; the state file is parsed, never evaluated; no output and no message
# ever carries the token, the chat id, a host name or a URL.
set -euo pipefail

image="${1:?usage: $0 <slax-backup image>}"
pg_image="postgres:16.15-alpine3.24@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab"
redis_image="redis:7.4.12-alpine3.21@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f"
python_image="python:3.12.16-slim-trixie@sha256:8523d6abeb48ceae0b7240d30c5808fc26cb79c1a635bacdf19cf3baecfbec07"
here="$(cd "$(dirname "$0")" && pwd)"

name="slax-monitor-test-$$"
target="$name-target"
disk_volume="$name-disk"
dir="$(mktemp -d)"
mkdir -m 777 "$dir/out" "$dir/ctl" "$dir/state"

cleanup() {
    docker rm -f "$target" "$name-telegram" "$name-pg" "$name-redis" "$name-disk" "$name-killed" > /dev/null 2>&1 || true
    docker volume rm "$disk_volume" > /dev/null 2>&1 || true
    docker network rm "$name" > /dev/null 2>&1 || true
    rm -rf "$dir"
}
trap cleanup EXIT

# Random secrets of this run: no output and no message may contain any of them.
bot_token="$((RANDOM + 100000)):$(openssl rand -hex 17)"
chat_id="-100$((RANDOM * RANDOM + 1000000))"
redis_password="$(openssl rand -hex 16)"
secrets=("$bot_token" "${bot_token#*:}" "$chat_id" "$redis_password")

docker network create "$name" > /dev/null
docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=10m,uid=70,gid=70 "$disk_volume" > /dev/null
# A tmpfs volume is mounted only while a container uses it: this one keeps it (and the test's
# fill) between the runs.
docker run -d --name "$name-disk" -u 70:70 -v "$disk_volume:/disk" "$image" sleep 3600 > /dev/null
echo 200 > "$dir/ctl/status"
docker run -d --name "$target" --network "$name" -u "$(id -u):$(id -g)" \
    -v "$here/fake-target.py:/target.py:ro" -v "$dir/ctl:/ctl:ro" "$python_image" python /target.py > /dev/null
docker run -d --name "$name-telegram" --network "$name" -u "$(id -u):$(id -g)" \
    -v "$here/../../backup/test/telegram-sink.py:/sink.py:ro" -v "$dir/out:/out" "$python_image" python /sink.py > /dev/null
docker run -d --name "$name-pg" --network "$name" -e POSTGRES_USER=slax -e POSTGRES_DB=slax \
    -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "$pg_image" > /dev/null
docker run -d --name "$name-redis" --network "$name" "$redis_image" redis-server --requirepass "$redis_password" > /dev/null

umask 077
cat > "$dir/env" << EOF
SLAX_ENV_LABEL=Prod
TELEGRAM_BOT_TOKEN=$bot_token
TELEGRAM_CHAT_ID=$chat_id
TELEGRAM_API_URL=http://$name-telegram:8080
PGUSER=slax
PGDATABASE=slax
MONITOR_TIMEOUT=2
EOF
umask 022

# The clock of the next run: one minute later each time (as the CronJob runs).
clock=1793000000
status=0
# monitor [docker run options...]: one run of uptime.sh, as in the cluster. Its output goes
# to $out (and is kept for the leak check), its exit code to $status.
monitor() {
    clock=$((clock + 60))
    out="$(docker run --rm --network "$name" --env-file "$dir/env" -e MONITOR_NOW="$clock" \
        -u 70:70 --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges \
        -v "${state_mount:-$dir/state:/state}" -v "$disk_volume:/disk" "$@" "$image" uptime.sh 2>&1)" && status=0 || status=$?
    printf '%s\n' "$out" >> "$dir/all-output"
}
set_target() { echo "$1" > "$dir/ctl/status"; }
# preload FILE KEY=VALUE...: a state file the test writes itself (as a previous run would).
preload() {
    local file="$dir/state/$1"
    shift
    rm -f "$file"
    printf '%s\n' "$@" > "$file"
    chmod 666 "$file"
}
# fill KIB: the watched disk holds exactly one file of that size.
fill() {
    docker exec "$name-disk" sh -c "rm -f /disk/fill; dd if=/dev/zero of=/disk/fill bs=1024 count=$1 2>/dev/null"
}
alerts() { cat "$dir/out/texts" 2> /dev/null | wc -l | tr -d ' '; }
last_alert() { tail -n 1 "$dir/out/texts" 2> /dev/null || true; }

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
has() { printf '%s\n' "$1" | grep -qE -- "$2"; }
starts() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }
matches() { printf '%s\n' "$1" | grep -qxE -- "$2"; }

for _ in $(seq 1 60); do
    if docker exec "$name-pg" pg_isready -q -h 127.0.0.1 -U slax && docker exec "$name-redis" redis-cli -a "$redis_password" --no-auth-warning ping 2> /dev/null | grep -q PONG &&
        docker run --rm --network "$name" "$image" curl -fsS -o /dev/null "http://$target:8080/" 2> /dev/null; then
        break
    fi
    sleep 1
done

app=(-e "MONITOR_CHECKS=app=http://$target:8080/api/v1/health")

echo "== health: 3 failures in a row before one alert, one recovery"
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "a healthy run exits 0, silently" test "$status $(alerts)" = "0 0"
check "... and logs a one-line summary" has "$out" 'uptime: app=ok \([0-9]+ s\)$'
set_target 503
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "2 failures: no alert, exit 0" test "$status $(alerts)" = "0 0"
check "... the summary names the failure" has "$out" 'uptime: app=FAIL\(HTTP 503\) \([0-9]+ s\)$'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "the 3rd failure in a row: one alert" test "$(alerts)" = 1
check "... [Prod], the check, the count, the status code and a UTC time" \
    matches "$(last_alert)" '\[Prod\] DOWN: app failed 3 checks in a row \(HTTP 503\), since [0-2][0-9]:[0-5][0-9] UTC\.'
check "... sent to the configured bot and chat" test "$(tail -n 1 "$dir/out/paths") $(tail -n 1 "$dir/out/chats")" = "/bot$bot_token/sendMessage $chat_id"
for _ in 1 2 3; do
    monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
done
check "3 more failures: no flood (still one alert)" test "$(alerts)" = 1
set_target 200
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "back up: one recovery message" test "$(alerts)" = 2
check "... with the status, the time down and the failed checks" \
    matches "$(last_alert)" '\[Prod\] RECOVERED: app is answering again \(HTTP 200\) after about 6 min down \(6 failed checks\)\.'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "still up: nothing more" test "$(alerts)" = 2
for answer in 503 503 200 503 503 200; do
    set_target "$answer"
    monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
done
check "failures that are not 3 in a row: nothing" test "$(alerts)" = 2

echo "== failure classes: timeout, closed connection, TLS, DNS (never a host or URL)"
set_target hang
for _ in 1 2 3; do
    monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
done
check "a hanging endpoint is a timeout (MONITOR_TIMEOUT), exit 0" test "$status" = 0
check "... alerted once as a timeout" matches "$(last_alert)" '\[Prod\] DOWN: app failed 3 checks in a row \(timeout\), since .*'
set_target close
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "... a connection closed without a reply is an empty reply" has "$out" 'app=FAIL\(empty reply\)'
set_target 200
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/a
check "... then one recovery" starts "$(last_alert)" '[Prod] RECOVERED: app is answering again (HTTP 200)'
before="$(alerts)"
for _ in 1 2 3; do
    monitor -e MONITOR_STATE_FILE=/state/c -e "MONITOR_CHECKS=public=https://$target:8080/api/v1/health dns=http://slax-no-such-host.invalid/api/v1/health"
done
check "HTTPS to something that does not speak TLS: a TLS error" has "$(tail -n 2 "$dir/out/texts")" '^\[Prod\] DOWN: public failed 3 checks in a row \(TLS error\)'
check "an unresolvable name: a DNS failure" has "$(tail -n 2 "$dir/out/texts")" '^\[Prod\] DOWN: dns failed 3 checks in a row \(DNS failure\)'
check "... one alert each" test "$(alerts)" = $((before + 2))

echo "== a Telegram outage delays alerts, never floods or loses them"
set_target 503
for _ in 1 2 3; do
    monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b -e TELEGRAM_API_URL=http://slax-no-telegram.invalid
done
before="$(alerts)"
check "Telegram unreachable at the 3rd failure: exit 0 all the same" test "$status" = 0
check "... a warning in the log (curl's exit code, no token)" has "$out" 'WARNING: the Telegram alert could not be sent \(curl exit [0-9]+\)'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b
check "Telegram back: the alert goes out at the next run" test "$(alerts)" = $((before + 1))
check "... once, with the real count" matches "$(last_alert)" '\[Prod\] DOWN: app failed 4 checks in a row \(HTTP 503\), since .*'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b
check "... and not again" test "$(alerts)" = $((before + 1))
set_target 200
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b -e TELEGRAM_API_URL=http://slax-no-telegram.invalid
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b
check "a recovery that could not be sent is sent at the next run, once" test "$(alerts)" = $((before + 2))
check "... as a recovery" starts "$(last_alert)" '[Prod] RECOVERED: app is answering again (HTTP 200)'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/b
check "... and not again" test "$(alerts)" = $((before + 2))

echo "== PostgreSQL and Redis, without their passwords"
deps=(-e "MONITOR_CHECKS=postgres=pg://$name-pg:5432 redis=redis://$name-redis:6379")
before="$(alerts)"
monitor -e MONITOR_STATE_FILE=/state/d "${deps[@]}"
check "both up: no alert (pg_isready; PING answered -NOAUTH)" test "$(alerts) $status" = "$before 0"
check "... the summary says ok for both" has "$out" 'uptime: postgres=ok redis=ok \([0-9]+ s\)$'
docker stop "$name-pg" "$name-redis" > /dev/null
for _ in 1 2 3; do monitor -e MONITOR_STATE_FILE=/state/d "${deps[@]}"; done
check "both down 3 times: one alert each" test "$(alerts)" = $((before + 2))
check "... naming PostgreSQL" has "$(tail -n 2 "$dir/out/texts")" '^\[Prod\] DOWN: postgres failed 3 checks in a row \((no answer|timeout)\)'
check "... and Redis" has "$(tail -n 2 "$dir/out/texts")" '^\[Prod\] DOWN: redis failed 3 checks in a row \((no answer|timeout)\)'
docker start "$name-pg" "$name-redis" > /dev/null
for _ in $(seq 1 60); do docker exec "$name-pg" pg_isready -q -h 127.0.0.1 -U slax 2> /dev/null && break; sleep 1; done
monitor -e MONITOR_STATE_FILE=/state/d "${deps[@]}"
check "both back: one recovery each" test "$(alerts)" = $((before + 4))
check "PostgreSQL logged no failed sign-in for the checks (right user and database names, no password sent)" \
    test -z "$(docker logs "$name-pg" 2>&1 | grep -E 'FATAL|authentication failed' || true)"

echo "== disk: above 80 % once, a reminder after 6 h, all clear below 75 %"
disks=(-e "MONITOR_DISKS=volumes=/disk again=/disk")
before="$(alerts)"
fill 1024
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "10 % used: no alert" test "$(alerts)" = "$before"
check "... two paths on one filesystem count once" has "$out" 'disk:volumes=1[01]% disk:again=same-as-volumes \([0-9]+ s\)$'
fill 8800
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "86 % used: one alert" test "$(alerts)" = $((before + 1))
check "... with the percentage and the thresholds" \
    matches "$(last_alert)" '\[Prod\] DISK: volumes disk 8[5-9]% full \(alert above 80%\)\. Reminder every 6 h while above; all clear below 75%\.'
for _ in 1 2 3; do
    monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
done
check "still above: no flood" test "$(alerts)" = $((before + 1))
clock=$((clock + 6 * 3600 - 4 * 60))
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "6 h after the alert: one reminder" test "$(alerts)" = $((before + 2))
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "... then quiet again" test "$(alerts)" = $((before + 2))
fill 7980
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "78 % (between 75 and 80): nothing (hysteresis)" test "$(alerts)" = $((before + 2))
check "... the summary shows it" has "$out" 'disk:volumes=7[89]%'
fill 5120
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "50 %: one all-clear" test "$(alerts)" = $((before + 3))
check "... saying so" matches "$(last_alert)" '\[Prod\] DISK OK: volumes disk back to 5[0-2]% \(below 75%\)\.'
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/e "${disks[@]}"
check "... once" test "$(alerts)" = $((before + 3))

echo "== the state file: parsed, never evaluated; rewritten in place at a fixed size"
# A file the test owns (mode 666), of the script's fixed size, with one valid entry (2
# failures already) and lines that would run commands if the file were sourced.
{
    # shellcheck disable=SC2016 # literal on purpose: they must never be expanded
    printf '%s\n' 'check.app.fails=2' '$(touch /state/pwned)=1' 'check.app.down=abc' 'x;touch /state/pwned2' \
        'check.app.since=99999999999999' '`touch /state/pwned3`'
} > "$dir/state/f"
truncate -s 2048 "$dir/state/f"
sed -i 's/\x0/\n/g' "$dir/state/f"
chmod 666 "$dir/state/f"
set_target 503
before="$(alerts)"
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/f
check "the valid entry is read: this failure is the 3rd in a row, alerted" test "$(alerts)" = $((before + 1))
check "... the malformed lines are counted and ignored" has "$out" 'WARNING: 5 malformed line\(s\) in the state file ignored\.'
check "... and none of them ran" test -z "$(find "$dir/state" -name 'pwned*')"
check "... the file was rewritten in place (same owner, same 2048 bytes: no new block needed)" \
    test "$(stat -c '%U %s' "$dir/state/f")" = "$(id -un) 2048"
check "... with key=integer lines only" test -z "$(grep -vxE '|[a-z][a-z0-9.-]*=[0-9]+' "$dir/state/f" || true)"
set_target 200
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/f
state_mount="$dir/state:/state:ro" monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/g
check "a state that cannot be saved: a warning, exit 0" test "$status" = 0
check "... saying so" has "$out" 'WARNING: the state could not be saved'

echo "== a disk that cannot be read keeps its alert flag"
before="$(alerts)"
preload k disk.volumes.alerted=1 "disk.volumes.last=$clock"
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/k -e MONITOR_DISKS=volumes=/no-such-path
check "an unreadable disk: a warning, nothing sent" test "$(alerts)" = "$before"
check "... saying so" has "$out" 'WARNING: cannot read the usage of disk "volumes"'
fill 1024
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/k -e MONITOR_DISKS=volumes=/disk
check "readable again, below 75 %: the all-clear still comes (the flag was kept)" \
    matches "$(last_alert)" '\[Prod\] DISK OK: volumes disk back to 1[01]% \(below 75%\)\.'

echo "== the real timeouts: everything hangs, Telegram too; the run still ends in time"
# Five checks that never answer, at the chart's timeouts (10 s per check, 5 s per Telegram
# call, a 35 s budget, the Job's deadline 50 s), each at its 3rd failure, two disks over
# the threshold: 7 alerts to send to a Telegram that holds every call.
set_target hang
hang_checks=(-e "MONITOR_CHECKS=app=http://$target:8080/api/v1/health reverb=http://$target:8080/up public=https://10.255.255.1/api/v1/health postgres=pg://10.255.255.1:5432 redis=redis://10.255.255.1:6379"
    -e "MONITOR_DISKS=node=/state volumes=/disk" -e MONITOR_DISK_ALERT_PERCENT=1 -e MONITOR_DISK_RECOVER_PERCENT=0
    -e MONITOR_TIMEOUT=10 -e MONITOR_TELEGRAM_TIMEOUT=5 -e MONITOR_BUDGET_SECONDS=35 -e MONITOR_STATE_FILE=/state/t)
preload t check.{app,reverb,public,postgres,redis}.fails=2 check.{app,reverb,public,postgres,redis}.since="$clock"
before="$(alerts)"
alerts > "$dir/out/hang"
started="$(date +%s)"
monitor "${hang_checks[@]}"
elapsed=$(($(date +%s) - started))
rm -f "$dir/out/hang"
echo "      (the run took ${elapsed} s, container start included)"
check "the run ends well inside the Job's 50 s deadline, exit 0" \
    test "$((elapsed < 48)) $status" = "1 0"
check "... the probes ran in parallel (one timeout for all five)" has "$out" 'uptime: app=FAIL\(timeout\) reverb=FAIL\(timeout\) public=FAIL\(timeout\) postgres=FAIL\((no answer|timeout)\) redis=FAIL\((timeout|no answer)\)'
check "... alerts that would end past the budget are deferred, not attempted" has "$out" 'deferred to the next run \(no time left in this one\)'
check "... nothing reached Telegram" test "$(alerts)" = "$before"
monitor "${hang_checks[@]}"
check "Telegram back, the next run: all 7 alerts, once each" test "$(alerts)" = $((before + 7))
check "... the 5 checks as DOWN at their 4th failure" test "$(tail -n 7 "$dir/out/texts" | grep -c 'failed 4 checks in a row')" = 5
check "... and the 2 disks" test "$(tail -n 7 "$dir/out/texts" | grep -c '^\[Prod\] DISK: ')" = 2
monitor "${hang_checks[@]}"
check "... and the run after: nothing more" test "$(alerts)" = $((before + 7))
set_target 200

echo "== killed right after an alert went out: that alert is never sent again"
set_target 503
two=(-e "MONITOR_CHECKS=first=http://$target:8080/a second=http://$target:8080/b" -e MONITOR_STATE_FILE=/state/u)
preload u check.{first,second}.fails=2 check.{first,second}.since="$clock"
before="$(alerts)"
# Telegram takes the first alert, then holds the second one; the run is SIGKILLed meanwhile.
echo $((before + 1)) > "$dir/out/hang"
clock=$((clock + 60))
docker run -d --name "$name-killed" --network "$name" --env-file "$dir/env" -e MONITOR_NOW="$clock" \
    -u 70:70 --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges \
    -v "$dir/state:/state" "${two[@]}" "$image" uptime.sh > /dev/null
for _ in $(seq 1 100); do [ "$(alerts)" -gt "$before" ] && break; sleep 0.1; done
sleep 1
docker kill "$name-killed" > /dev/null
docker logs "$name-killed" >> "$dir/all-output" 2>&1
docker rm "$name-killed" > /dev/null
rm -f "$dir/out/hang"
check "the first alert went out before the kill" test "$(alerts)" = $((before + 1))
check "... DOWN: first" starts "$(last_alert)" '[Prod] DOWN: first failed 3 checks in a row'
monitor "${two[@]}"
check "the next run sends only the one that never went out" test "$(alerts)" = $((before + 2))
check "... DOWN: second, at its 3rd failure (the killed run's look at it was never saved)" \
    starts "$(last_alert)" '[Prod] DOWN: second failed 3 checks in a row'
check "... DOWN: first exactly once in all" test "$(grep -c '^\[Prod\] DOWN: first ' "$dir/out/texts")" = 1
set_target 200

echo "== configuration errors fail the Job (exit 2), nothing is sent"
before="$(alerts)"
monitor -e MONITOR_STATE_FILE=/state/h -e MONITOR_CHECKS=app=ftp://example.invalid/
check "an unsupported check" test "$status" = 2
monitor -e MONITOR_STATE_FILE=/state/h -e "MONITOR_CHECKS=App=http://$target:8080/"
check "a name that is not [a-z][a-z0-9-]*" test "$status" = 2
monitor -e MONITOR_STATE_FILE=/state/h -e MONITOR_CHECKS=
check "no check at all" test "$status" = 2
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/h -e MONITOR_DISK_RECOVER_PERCENT=90
check "an all-clear threshold above the alert threshold" test "$status" = 2
monitor "${app[@]}" -e MONITOR_STATE_FILE=/state/h -e MONITOR_TIMEOUT=30 -e MONITOR_BUDGET_SECONDS=30
check "a budget with no room for the checks and one alert" test "$status" = 2
check "... no message sent" test "$(alerts)" = "$before"

echo "== every alert, every output"
check "every message starts with [Prod]" test -z "$(grep -v '^\[Prod\] ' "$dir/out/texts")"
leaks=0
for secret in "${secrets[@]}"; do
    if grep -qF -- "$secret" "$dir/out/texts" "$dir/all-output"; then leaks=$((leaks + 1)); fi
done
check "no message and no output carries the token, the chat id or a password" test "$leaks" = 0
check "no message carries a host name or a URL" test -z "$(grep -E "$name|https?:|\.invalid|/api/" "$dir/out/texts" || true)"
check "messages are short (under 200 characters)" test -z "$(awk 'length > 200' "$dir/out/texts")"
echo "Messages sent:"
sed 's/^/  /' "$dir/out/texts"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All monitor checks passed"
