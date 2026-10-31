#!/usr/bin/env bash
# The light load test on a fresh e2e stack (make load / make load-smoke):
#
#   e2e/load/run.sh full    50 clients, 25 senders, 10 messages/s for 2 minutes
#                           -> docs/load-test-results.md (commit it with the machine noted)
#   e2e/load/run.sh smoke   5 clients, 2 messages/s for 10 s -> build/load/load-test-results.md
#
# The stack is the end-to-end one (docker-compose.e2e.yml, APP_ENV=e2e: the stand-in for
# Google), under a Compose project of its own with fresh volumes, removed afterwards. While
# the clients run (e2e/load/load.mjs, in the `load` service), `docker stats` samples every
# container's memory and CPU every 5 s; e2e/load/report.mjs turns both into the report.
# Exit status: the load test's (non-zero on any loss, duplicate, HTTP or WebSocket error).
set -euo pipefail

profile="${1:-full}"
cd "$(dirname "$0")/../.."
case "$profile" in
    full)
        export LOAD_CLIENTS=50 LOAD_SENDERS=25 LOAD_RATE=10 LOAD_SECONDS=120
        report=docs/load-test-results.md
        ;;
    smoke)
        export LOAD_CLIENTS=5 LOAD_SENDERS=5 LOAD_RATE=2 LOAD_SECONDS=10
        report=build/load/load-test-results.md
        ;;
    *)
        echo "usage: $0 full|smoke" >&2
        exit 2
        ;;
esac

dc=(docker compose --progress quiet -p slax-load --env-file e2e/stack.env -f docker-compose.yml -f docker-compose.e2e.yml)
node_image="$(sed -n 's/^ *image: \(node:24[^ ]*\)$/\1/p' docker-compose.e2e.yml | head -n 1)"
out=build/load
sampler=""

# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
    [ -z "$sampler" ] || kill "$sampler" 2> /dev/null || true
    "${dc[@]}" --profile load down -v --remove-orphans > /dev/null 2>&1 || true
}
trap cleanup EXIT

APP_KEY="base64:$(openssl rand -base64 32)"
export APP_KEY
mkdir -p "$out" frontend/dist-e2e
rm -f "$out/stats.tsv" "$out/results.json" "$out/machine.json"

echo "==> Starting a fresh e2e stack (project slax-load)"
"${dc[@]}" --profile load down -v --remove-orphans > /dev/null 2>&1 || true
"${dc[@]}" build --quiet app scanner
"${dc[@]}" up -d --wait app reverb queue web scanner minio
"${dc[@]}" exec -T app php artisan migrate --force --no-interaction --quiet
"${dc[@]}" exec -T app php artisan db:seed --class=DefaultWorkspaceSeeder --force --no-interaction --quiet

# The machine, for the report (no host name, no user name).
mem_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
cat > "$out/machine.json" << EOF
{
  "cpu": "$(lscpu 2> /dev/null | sed -n 's/^Model name: *//p' | head -n 1)",
  "threads": $(nproc),
  "memory_gib": $(awk -v k="$mem_kib" 'BEGIN { printf "%.1f", k / 1048576 }'),
  "os": "$(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release)",
  "kernel": "$(uname -r)",
  "docker": "$(docker version --format '{{.Server.Version}}')",
  "arch": "$(uname -m)"
}
EOF

echo "==> Sampling docker stats every 5 s"
mapfile -t containers < <("${dc[@]}" ps -q)
(
    while :; do
        started="$(date +%s)"
        docker stats --no-stream --format '{{.Name}}	{{.MemUsage}}	{{.CPUPerc}}' "${containers[@]}" 2> /dev/null |
            sed "s/^/$(date +%s%3N)	/" >> "$out/stats.tsv" || true
        elapsed=$(($(date +%s) - started))
        [ "$elapsed" -ge 5 ] || sleep $((5 - elapsed))
    done
) &
sampler=$!
sleep 6 # an idle sample first

echo "==> Load ($profile: $LOAD_CLIENTS clients, $LOAD_RATE messages/s for $LOAD_SECONDS s)"
status=0
"${dc[@]}" --profile load run --rm -T load || status=$?
sleep 6 # a sample after the run
kill "$sampler" 2> /dev/null || true
wait "$sampler" 2> /dev/null || true
sampler=""

if [ -f "$out/results.json" ]; then
    docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/e2e/load:/load:ro" -v "$PWD/$out:/in:ro" -v "$PWD/$(dirname "$report"):/report" \
        -e REPORT=/report/"$(basename "$report")" -e PROFILE="$profile" "$node_image" node /load/report.mjs
    echo "Report: $report"
fi
exit "$status"
