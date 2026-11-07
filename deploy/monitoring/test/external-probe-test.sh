#!/usr/bin/env bash
# deploy/monitoring/external-probe.sh against a throwaway health endpoint and a fake Telegram
# (make external-probe-test). Needs bash, curl and python3 only: no container.
#
# Checks: one failure says nothing, the 2nd in a row one "DOWN" (label, check name, status,
# UTC time), more failures nothing more, the recovery one message; a refused connection counts
# like any failure; the failure count survives between runs in PROBE_STATE_DIR (what the
# workflow's cache carries); a wrong invocation exits 2; no output and no message carries the
# token, the chat id or the URL.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
probe="$here/../external-probe.sh"
dir="$(mktemp -d)"
server_pid=""
cleanup() {
    [ -z "$server_pid" ] || kill "$server_pid" 2> /dev/null || true
    rm -rf "$dir"
}
trap cleanup EXIT

mkdir "$dir/out" "$dir/state"
echo 200 > "$dir/status"

cat > "$dir/server.py" << 'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

root = sys.argv[1]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        with open(f"{root}/status", encoding="utf-8") as ctl:
            code = int(ctl.read().strip() or "200")
        body = b'{"status":"ok"}'
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode())
        for name, value in (("paths", self.path), ("chats", form.get("chat_id", [""])[0]), ("texts", form.get("text", [""])[0])):
            with open(f"{root}/out/{name}", "a", encoding="utf-8") as out:
                out.write(value.replace("\n", " ") + "\n")
        reply = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY

python3 -I "$dir/server.py" "$dir" > "$dir/port" &
server_pid=$!
for _ in $(seq 1 50); do
    [ -s "$dir/port" ] && break
    sleep 0.1
done
port="$(cat "$dir/port")"
[ -n "$port" ] || { echo "the fake server did not start"; exit 1; }
url="http://127.0.0.1:$port/api/v1/health"

bot_token="$((RANDOM + 100000)):$(openssl rand -hex 17)"
chat_id="-100$((RANDOM * RANDOM + 1000000))"

status=0
run() { # label url: one run of the probe; its output goes to $out
    # Into a file, not a command substitution: uptime.sh's watchdog leaves its `sleep` behind
    # for 12 s, and a substitution would wait for it.
    TELEGRAM_BOT_TOKEN="$bot_token" TELEGRAM_CHAT_ID="$chat_id" TELEGRAM_API_URL="http://127.0.0.1:$port" \
        PROBE_STATE_DIR="$dir/state" "$probe" "$1" "$2" > "$dir/run-output" 2>&1 && status=0 || status=$?
    out="$(cat "$dir/run-output")"
    cat "$dir/run-output" >> "$dir/all-output"
}
alerts() { cat "$dir/out/texts" 2> /dev/null | wc -l | tr -d ' '; }
last_alert() { tail -n 1 "$dir/out/texts" 2> /dev/null || true; }
reset() { # a new scenario: the messages so far are kept for the leak check at the end
    cat "$dir/out/texts" >> "$dir/all-texts" 2> /dev/null || true
    rm -rf "${dir:?}/out"/* "${dir:?}/state"/*
}

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
matches() { printf '%s\n' "$1" | grep -qxE -- "$2"; }
has() { printf '%s\n' "$1" | grep -qE -- "$2"; }

echo "== two failures in a row before one alert, one recovery"
run Dev "$url"
check "a healthy run exits 0, silently" test "$status $(alerts)" = "0 0"
check "... and logs a one-line summary" has "$out" 'uptime: external=ok'
echo 503 > "$dir/status"
run Dev "$url"
check "1 failure: no alert, exit 0" test "$status $(alerts)" = "0 0"
run Dev "$url"
check "the 2nd failure in a row: one alert" test "$(alerts)" = 1
check "... [Dev], the check, the count, the status and a UTC time" \
    matches "$(last_alert)" '\[Dev\] DOWN: external failed 2 checks in a row \(HTTP 503\), since [0-2][0-9]:[0-5][0-9] UTC\.'
check "... sent to the configured bot and chat" test "$(tail -n 1 "$dir/out/paths") $(tail -n 1 "$dir/out/chats")" = "/bot$bot_token/sendMessage $chat_id"
for _ in 1 2 3; do run Dev "$url"; done
check "3 more failures: no flood (still one alert)" test "$(alerts)" = 1
echo 200 > "$dir/status"
run Dev "$url"
check "the recovery: one more alert" test "$(alerts)" = 2
check "... RECOVERED with the status and the failed checks" \
    matches "$(last_alert)" '\[Dev\] RECOVERED: external is answering again \(HTTP 200\) after about [0-9]+ min down \(5 failed checks\)\.'
run Dev "$url"
check "healthy again: nothing more" test "$(alerts)" = 2

echo "== a refused connection, and the Prod label"
reset
dead_url="http://127.0.0.1:1/api/v1/health"
run Prod "$dead_url"
run Prod "$dead_url"
check "2 refused connections: one alert" test "$(alerts)" = 1
check "... [Prod] with the failure class" \
    matches "$(last_alert)" '\[Prod\] DOWN: external failed 2 checks in a row \(connection refused\), since [0-2][0-9]:[0-5][0-9] UTC\.'

echo "== the threshold is adjustable; a flapping check never alerts"
reset
echo 503 > "$dir/status"
PROBE_FAIL_THRESHOLD=3 run Dev "$url"
PROBE_FAIL_THRESHOLD=3 run Dev "$url"
check "threshold 3: two failures say nothing" test "$(alerts)" = 0
echo 200 > "$dir/status"
run Dev "$url"
echo 503 > "$dir/status"
run Dev "$url"
check "fail, pass, fail: the count restarted, still nothing" test "$(alerts)" = 0

echo "== invocation"
out="$("$probe" Staging "$url" 2>&1)" && status=0 || status=$?
check "an unknown label exits 2" test "$status" = 2
out="$("$probe" Dev "ftp://example.test/" 2>&1)" && status=0 || status=$?
check "a non-HTTP URL exits 2" test "$status" = 2
out="$("$probe" 2>&1)" && status=0 || status=$?
check "no argument exits 2" test "$status" = 2

echo "== no secret, no URL in the output or in a message"
reset
check "messages were recorded for the leak check" test -s "$dir/all-texts"
for secret in "$bot_token" "${bot_token#*:}" "$chat_id" "127.0.0.1:$port" "/api/v1/health"; do
    check "nothing says '${secret:0:6}...'" bash -c '! grep -qF -- "$1" "$2" "$3"' _ "$secret" "$dir/all-output" "$dir/all-texts"
done

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
