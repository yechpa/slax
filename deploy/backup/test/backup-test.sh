#!/usr/bin/env bash
# The backup scripts against throwaway services, in containers (make backup-test):
#   - a "production" PostgreSQL 16 with a small users/migrations schema;
#   - a throwaway PostgreSQL 16 for the restore (as the CronJob's sidecar is);
#   - MinIO as S3 (with a KMS key, so server-side encryption is real);
#   - a fake Telegram (deploy/backup/test/telegram-sink.py) recording every alert.
# The scripts run in the slax-backup image as in the cluster: uid 70, read-only root
# filesystem, no capability.
#
#   deploy/backup/test/backup-test.sh <slax-backup image>
#
# Checks: a backup lands under pg/YYYY/MM/DD/ encrypted and silently; the restore check
# restores it and says so on Telegram; a dump without users, a corrupt dump, a stale backup
# and a failing pg_dump each fail with a "[Prod] ..." alert; no alert ever carries a secret.
set -euo pipefail

image="${1:?usage: $0 <slax-backup image>}"
pg_image="postgres:16.15-alpine3.24@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab"
minio_image="cgr.dev/chainguard/minio:latest@sha256:3b6e40c30ecd5cea627e382ff0b82ca841f58c52294578787043ee80c8ef7c82"
python_image="python:3.12.16-slim-trixie@sha256:8523d6abeb48ceae0b7240d30c5808fc26cb79c1a635bacdf19cf3baecfbec07"
here="$(cd "$(dirname "$0")" && pwd)"

name="slax-backup-test-$$"
bucket="slax-backups-test"
dir="$(mktemp -d)"
mkdir -m 777 "$dir/out"

cleanup() {
    docker rm -f "$name-src" "$name-restore" "$name-minio" "$name-telegram" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    rm -rf "$dir"
}
trap cleanup EXIT

# Random secrets of this run: the alerts must never contain any of them.
db_password="$(openssl rand -hex 16)"
s3_secret="$(openssl rand -hex 20)"
bot_token="$((RANDOM + 100000)):$(openssl rand -hex 17)"
chat_id="-100$((RANDOM * RANDOM + 1000000))"
secrets=("$db_password" "$s3_secret" "$bot_token" "${bot_token#*:}" "$chat_id")

docker network create "$name" >/dev/null
docker run -d --name "$name-src" --network "$name" \
    -e POSTGRES_USER=slax -e POSTGRES_DB=slax -e POSTGRES_PASSWORD="$db_password" "$pg_image" >/dev/null
docker run -d --name "$name-restore" --network "$name" -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" >/dev/null
docker run -d --name "$name-minio" --network "$name" \
    -e MINIO_ROOT_USER=slaxtest -e MINIO_ROOT_PASSWORD="$s3_secret" \
    -e MINIO_KMS_SECRET_KEY="slax-test:$(openssl rand -base64 32)" \
    "$minio_image" server /data >/dev/null
docker run -d --name "$name-telegram" --network "$name" -u "$(id -u):$(id -g)" \
    -v "$here/telegram-sink.py:/sink.py:ro" -v "$dir/out:/out" "$python_image" python /sink.py >/dev/null

# The scripts' environment, in a private file (not on any command line).
umask 077
cat > "$dir/env" <<EOF
PGHOST=$name-src
PGUSER=slax
PGDATABASE=slax
PGPASSWORD=$db_password
BACKUP_BUCKET=$bucket
AWS_ENDPOINT_URL=http://$name-minio:9000
AWS_ACCESS_KEY_ID=slaxtest
AWS_SECRET_ACCESS_KEY=$s3_secret
AWS_REGION=eu-central-1
RESTORE_PGHOST=$name-restore
SLAX_ENV_LABEL=Prod
TELEGRAM_BOT_TOKEN=$bot_token
TELEGRAM_CHAT_ID=$chat_id
TELEGRAM_API_URL=http://$name-telegram:8080
EOF
umask 022

# run [docker run options...] -- command...: in the backup image, as in the cluster.
run() {
    local options=()
    while [ "$1" != -- ]; do options+=("$1"); shift; done
    shift
    docker run --rm --network "$name" --env-file "$dir/env" -u 70:70 --read-only --tmpfs /tmp:mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges "${options[@]}" "$image" "$@"
}
src_sql() { docker exec -i "$name-src" psql -q -v ON_ERROR_STOP=1 -U slax -d slax "$@"; }
alerts() { cat "$dir/out/texts" 2>/dev/null | wc -l | tr -d ' '; }
last_alert() { tail -n 1 "$dir/out/texts" 2>/dev/null || true; }

for _ in $(seq 1 60); do
    if docker exec "$name-src" pg_isready -q -h 127.0.0.1 -U slax && docker exec "$name-restore" pg_isready -q -h 127.0.0.1 \
        && run -- aws s3api list-buckets >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
run -- aws s3api create-bucket --bucket "$bucket" >/dev/null

src_sql <<'SQL'
CREATE TABLE migrations (id serial PRIMARY KEY, migration varchar(255) NOT NULL, batch integer NOT NULL);
INSERT INTO migrations (migration, batch) VALUES
    ('0001_01_01_000000_create_users_table', 1), ('0001_01_01_000001_create_cache_table', 1), ('2026_10_30_000000_create_channels_table', 1);
CREATE TABLE users (id bigserial PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL);
INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.test'), ('Grace', 'grace@example.test'), ('Linus', 'linus@example.test');
SQL

failures=0
check() { # description, command...
    local description="$1"
    shift
    if "$@"; then echo "ok:   $description"; else echo "FAIL: $description"; failures=$((failures + 1)); fi
}
has() { printf '%s\n' "$1" | grep -qE -- "$2"; }
starts() { case "$1" in "$2"*) return 0 ;; *) return 1 ;; esac; }

echo "== backup"
out="$(run -- pg-backup.sh 2>&1)" && status=0 || status=$?
check "pg-backup.sh succeeds" test "$status" = 0
check "... into pg/YYYY/MM/DD/slax-<UTC time>.dump" has "$out" "^backup ok: s3://$bucket/pg/$(date -u +%Y/%m/%d)/slax-[0-9]{8}T[0-9]{6}Z\\.dump "
keys="$(run -- aws s3api list-objects-v2 --bucket "$bucket" --query 'Contents[].Key' --output text)"
first_key="$(printf '%s' "$keys" | tr '\t' '\n' | head -n 1)"
check "... one object in the bucket" test "$(printf '%s' "$keys" | wc -w | tr -d ' ')" = 1
check "... encrypted at rest (SSE-S3)" test "$(run -- aws s3api head-object --bucket "$bucket" --key "$first_key" --query ServerSideEncryption --output text)" = AES256
check "... silently (no Telegram message on success)" test "$(alerts)" = 0

echo "== restore check"
out="$(run -- restore-check.sh 2>&1)" && status=0 || status=$?
check "restore-check.sh succeeds" test "$status" = 0
check "... and prints a summary with the counts" has "$out" '^restore check ok: backup of .* restored in [0-9]+ s: 3 users, 3 migrations '
check "... sends one Telegram message" test "$(alerts)" = 1
check "... starting with [Prod], saying OK" starts "$(last_alert)" "[Prod] Weekly restore check OK: backup of "
check "... to the configured bot and chat" test "$(tail -n 1 "$dir/out/paths") $(tail -n 1 "$dir/out/chats")" = "/bot$bot_token/sendMessage $chat_id"
check "... and drops the throwaway database" test -z "$(docker exec "$name-restore" psql -tA -U postgres -c "SELECT 1 FROM pg_database WHERE datname = 'slax_restore_check'")"

echo "== a backup without users"
sleep 1
src_sql -c 'TRUNCATE users'
run -- pg-backup.sh >/dev/null 2>&1 && status=0 || status=$?
check "the backup itself succeeds (the table is there)" test "$status" = 0
run -- restore-check.sh >/dev/null 2>&1 && status=0 || status=$?
check "the restore check fails" test "$status" != 0
check "... with a [Prod] alert naming the check" starts "$(last_alert)" '[Prod] Restore check FAILED at step "users > 0"'

echo "== a corrupt backup (the newest)"
printf 'PGDMP this is not a dump\n' > "$dir/corrupt.dump"
chmod 644 "$dir/corrupt.dump"
corrupt_key="pg/$(date -u +%Y/%m/%d)/slax-$(date -u -d '+1 minute' +%Y%m%dT%H%M%SZ).dump"
run -v "$dir/corrupt.dump:/in/corrupt.dump:ro" -- aws s3 cp --only-show-errors /in/corrupt.dump "s3://$bucket/$corrupt_key"
before="$(alerts)"
run -- restore-check.sh >/dev/null 2>&1 && status=0 || status=$?
check "the restore check fails" test "$status" != 0
check "... with one more alert" test "$(alerts)" = $((before + 1))
check "... starting with [Prod], naming the step" starts "$(last_alert)" '[Prod] Restore check FAILED at step "pg_restore --list"'

echo "== a stale backup"
run -e MAX_AGE_HOURS=0 -- restore-check.sh >/dev/null 2>&1 && status=0 || status=$?
check "the restore check fails when the latest backup is too old" test "$status" != 0
check "... with a [Prod] alert" starts "$(last_alert)" '[Prod] Restore check FAILED at step "backup age"'

echo "== a failing backup"
run -e PGPASSWORD=wrong -- pg-backup.sh >/dev/null 2>&1 && status=0 || status=$?
check "pg-backup.sh fails when pg_dump fails" test "$status" != 0
check "... with a [Prod] alert naming pg_dump" starts "$(last_alert)" '[Prod] Backup FAILED at step "pg_dump"'
run -e BACKUP_BUCKET=slax-no-such-bucket -- pg-backup.sh >/dev/null 2>&1 && status=0 || status=$?
check "pg-backup.sh fails when the upload fails" test "$status" != 0
check "... with a [Prod] alert naming the upload and the error class" starts "$(last_alert)" '[Prod] Backup FAILED at step "upload (NoSuchBucket)"'

echo "== listing errors are not \"no backup\""
run -e BACKUP_BUCKET=slax-no-such-bucket -- restore-check.sh >/dev/null 2>&1 && status=0 || status=$?
check "the restore check fails when the bucket cannot be listed" test "$status" != 0
check "... naming the listing and the error class" starts "$(last_alert)" '[Prod] Restore check FAILED at step "list the backups (NoSuchBucket)"'
run -e AWS_SECRET_ACCESS_KEY=wrong-secret -- restore-check.sh >/dev/null 2>&1 && status=0 || status=$?
check "... and when the credentials are refused" starts "$(last_alert)" '[Prod] Restore check FAILED at step "list the backups (SignatureDoesNotMatch)"'

echo "== SIGTERM (deadline, eviction): alerted at once, not lost"
# terminate NAME ARGS...: start a script in the background, SIGTERM it after 3 s as Kubernetes
# would (docker stop), print "<exit code> <seconds from the signal to the end>".
terminate() {
    local cname="$name-term-$1" started
    shift
    docker run -d --name "$cname" --network "$name" --env-file "$dir/env" -u 70:70 --read-only --tmpfs /tmp:mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges "$@" >/dev/null
    sleep 3
    started="$(date +%s)"
    docker stop -t 30 "$cname" >/dev/null
    echo "$(docker wait "$cname") $(($(date +%s) - started))"
    docker rm "$cname" >/dev/null
}
# pg_dump stuck connecting to an address that never answers.
read -r code seconds <<< "$(terminate dump -e PGHOST=10.255.255.1 -e PGCONNECT_TIMEOUT=60 "$image" pg-backup.sh)"
check "pg-backup.sh exits 143 on SIGTERM, within seconds (not killed after the grace period)" test "$code $((seconds < 10))" = "143 1"
check "... with a [Prod] alert saying it was terminated, and where" starts "$(last_alert)" '[Prod] Backup TERMINATED at step "pg_dump" (SIGTERM'
# S3 at an address that never answers: the listing hangs.
read -r code seconds <<< "$(terminate restore -e AWS_ENDPOINT_URL=http://10.255.255.1:9000 "$image" restore-check.sh)"
check "restore-check.sh exits 143 on SIGTERM, within seconds" test "$code $((seconds < 10))" = "143 1"
check "... with a [Prod] alert" starts "$(last_alert)" '[Prod] Restore check TERMINATED at step "list the backups" (SIGTERM'

echo "== every alert"
check "every message starts with [Prod]" test -z "$(grep -v '^\[Prod\] ' "$dir/out/texts")"
leaks=0
for secret in "${secrets[@]}"; do
    if grep -qF -- "$secret" "$dir/out/texts"; then leaks=$((leaks + 1)); fi
done
check "no message carries a password, key, token or chat id" test "$leaks" = 0
check "no message carries a user's personal data" test -z "$(grep -E 'example\.test|Ada|Grace' "$dir/out/texts" || true)"
echo "Messages sent:"
sed 's/^/  /' "$dir/out/texts"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All backup checks passed"
