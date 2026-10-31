#!/usr/bin/env bash
# Weekly proof that the backups restore (CronJob slax-restore-check, Helm chart
# backup.enabled; image slax-backup).
#
#   the latest s3://$BACKUP_BUCKET/$BACKUP_PREFIX/YYYY/MM/DD/slax-<UTC time>.dump, younger
#   than MAX_AGE_HOURS -> download -> pg_restore --list -> restore into a throwaway database
#   on a throwaway server (RESTORE_PGHOST: in the cluster, a PostgreSQL sidecar living only in
#   this pod; never the production server) -> users > 0 and the migrations table filled ->
#   drop the database -> a short summary.
#
# Success or failure, a Telegram message says so ("[Prod] Weekly restore check OK ..." or
# "[Prod] Restore check FAILED ..."), and a failure exits non-zero.
#
# Environment:
#   BACKUP_BUCKET (required), BACKUP_PREFIX (pg), MAX_AGE_HOURS (36)
#   RESTORE_PGHOST (127.0.0.1), RESTORE_PGPORT (5432), RESTORE_PGUSER (postgres),
#   RESTORE_PGPASSWORD (none: trust on the pod's loopback), RESTORE_DB (slax_restore_check)
#   AWS_REGION, AWS credentials (default chain: the EC2 instance role)
#   SLAX_ENV_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (lib.sh)
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh
. "$here/lib.sh"

step="configuration"
work=""
created=""
started="$(date +%s)"

finish() {
    local status=$?
    if [ -n "$created" ]; then
        psql --no-psqlrc -q -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" >/dev/null 2>&1 || true
    fi
    [ -z "$work" ] || rm -rf "$work"
    if [ -n "$terminated" ]; then
        alert "Restore check TERMINATED at step \"${step}\" (SIGTERM: deadline or eviction): the backups were not verified this week."
    elif [ "$status" -ne 0 ]; then
        log "restore check FAILED at step: $step (exit $status)"
        alert "Restore check FAILED at step \"${step}\" (exit ${status}). The latest backup may not be restorable: docs/runbook.md, \"Backups\"."
    fi
    exit "$status"
}
trap finish EXIT

require BACKUP_BUCKET
prefix="${BACKUP_PREFIX:-pg}"
max_age_hours="${MAX_AGE_HOURS:-36}"
RESTORE_DB="${RESTORE_DB:-slax_restore_check}"
[[ "$prefix" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || { log "BACKUP_PREFIX has unexpected characters"; exit 2; }
[[ "$max_age_hours" =~ ^[0-9]+$ ]] || { log "MAX_AGE_HOURS must be a number of hours"; exit 2; }
# A throwaway database only: the name must say so (never the production database's name).
[[ "$RESTORE_DB" =~ ^[a-z_]*restore[a-z0-9_]*$ ]] || { log "RESTORE_DB must be a throwaway name containing 'restore'"; exit 2; }

# Every libpq connection from here on goes to the throwaway server.
export PGHOST="${RESTORE_PGHOST:-127.0.0.1}" PGPORT="${RESTORE_PGPORT:-5432}" PGUSER="${RESTORE_PGUSER:-postgres}"
unset PGDATABASE PGPASSWORD
[ -z "${RESTORE_PGPASSWORD:-}" ] || export PGPASSWORD="$RESTORE_PGPASSWORD"

work="$(mktemp -d)"

step="list the backups"
# A listing error is not "no backup": the alert names its class (AccessDenied, NoSuchBucket,
# network, ...).
if ! run aws s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "$prefix/" --query 'Contents[].Key' --output text \
    > "$work/list" 2> "$work/list.err"; then
    step="list the backups ($(aws_error_class "$work/list.err"))"
    exit 1
fi
listing="$(cat "$work/list")"

step="find the latest backup"
key_re="^${prefix//./\\.}/[0-9]{4}/[0-9]{2}/[0-9]{2}/slax-[0-9]{8}T[0-9]{6}Z\\.dump$"
key="$(printf '%s\n' "$listing" | tr '\t' '\n' | grep -E "$key_re" | sort | tail -n 1 || true)"
[ -n "$key" ] || { log "no backup under s3://$BACKUP_BUCKET/$prefix/"; exit 1; }
log "latest backup: s3://$BACKUP_BUCKET/$key"

step="backup age"
stamp="${key##*/slax-}"
stamp="${stamp%Z.dump}"
taken="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s)"
age_hours=$((($(date -u +%s) - taken) / 3600))
[ "$age_hours" -lt "$max_age_hours" ] || { log "the latest backup is $age_hours hours old (limit $max_age_hours): backups have stopped"; exit 1; }

step="download"
dump="$work/latest.dump"
if ! run aws s3 cp --only-show-errors --no-progress "s3://$BACKUP_BUCKET/$key" "$dump" 2> "$work/download.err"; then
    step="download ($(aws_error_class "$work/download.err"))"
    exit 1
fi
size="$(stat -c %s "$dump")"
[ "$size" -gt 0 ] || { log "the backup is empty"; exit 1; }

step="pg_restore --list"
run pg_restore --list "$dump" > /dev/null

step="throwaway server"
for _ in $(seq 1 60); do
    pg_isready -q -d postgres && break
    run sleep 1
done
pg_isready -q -d postgres

step="create the throwaway database"
psql --no-psqlrc -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" -c "CREATE DATABASE \"$RESTORE_DB\""
created=1

step="pg_restore"
restore_started="$(date +%s)"
run pg_restore --no-owner --no-acl --exit-on-error --dbname="$RESTORE_DB" "$dump"
restore_seconds=$(($(date +%s) - restore_started))

step="users > 0"
users="$(psql --no-psqlrc -tA -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -c 'SELECT count(*) FROM users')"
[[ "$users" =~ ^[0-9]+$ ]] && [ "$users" -gt 0 ] || { log "the restored database has no users ($users)"; exit 1; }

step="migrations table"
migrations="$(psql --no-psqlrc -tA -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -c 'SELECT count(*) FROM migrations')"
[[ "$migrations" =~ ^[0-9]+$ ]] && [ "$migrations" -gt 0 ] || { log "the restored database has no migrations ($migrations)"; exit 1; }

step="drop the throwaway database"
psql --no-psqlrc -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE \"$RESTORE_DB\""
created=""

step="done"
taken_at="${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2} UTC"
summary="backup of ${taken_at} ($(human "$size")) restored in ${restore_seconds} s: ${users} users, ${migrations} migrations"
echo "restore check ok: $summary (s3://$BACKUP_BUCKET/$key, $(($(date +%s) - started)) s in all)"
alert "Weekly restore check OK: $summary."
