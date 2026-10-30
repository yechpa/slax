#!/usr/bin/env bash
# Daily backup of the Slax PostgreSQL database to S3 (CronJob slax-backup, Helm chart
# backup.enabled; image slax-backup, docker/backup/Dockerfile).
#
#   pg_dump (custom format, compressed) -> size > 0 -> pg_restore --list (the archive reads
#   back, the users table is in it) -> upload with server-side encryption to
#   s3://$BACKUP_BUCKET/$BACKUP_PREFIX/YYYY/MM/DD/slax-<UTC time>.dump -> the stored size
#   matches.
#
# Any failure exits non-zero and sends a "[Prod] Backup FAILED ..." Telegram alert naming the
# step. A success is silent: the weekly restore check (restore-check.sh) is the "it works"
# message. Old dumps are removed by the bucket's lifecycle rule (35 days), never by this
# script: the instance role cannot delete backups at all.
#
# Environment:
#   PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD   the database (libpq variables)
#   BACKUP_BUCKET                                required
#   BACKUP_PREFIX                                pg
#   BACKUP_SSE                                   AES256 (SSE-S3)
#   AWS_REGION, AWS credentials                  default chain: the EC2 instance role
#   SLAX_ENV_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   alerts (lib.sh)
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh
. "$here/lib.sh"

step="configuration"
work=""
started="$(date +%s)"

finish() {
    local status=$?
    [ -z "$work" ] || rm -rf "$work"
    if [ "$status" -ne 0 ]; then
        log "backup FAILED at step: $step (exit $status)"
        alert "Backup FAILED at step \"${step}\" (exit ${status}). Today's database backup is missing: kubectl -n slax logs -l app.kubernetes.io/component=backup"
    fi
    exit "$status"
}
trap finish EXIT

require PGHOST PGUSER PGDATABASE BACKUP_BUCKET
prefix="${BACKUP_PREFIX:-pg}"
sse="${BACKUP_SSE-AES256}"
[[ "$prefix" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || { log "BACKUP_PREFIX has unexpected characters"; exit 2; }
[[ "$BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { log "BACKUP_BUCKET is not a bucket name"; exit 2; }

work="$(mktemp -d)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="$prefix/$(date -u +%Y/%m/%d)/slax-$stamp.dump"
dump="$work/slax-$stamp.dump"

step="pg_dump"
log "dumping $PGDATABASE from $PGHOST"
pg_dump --format=custom --compress=6 --no-password --lock-wait-timeout=60s --file="$dump"

step="dump size"
size="$(stat -c %s "$dump")"
[ "$size" -gt 0 ] || { log "the dump is empty"; exit 1; }

step="pg_restore --list"
toc="$work/toc"
pg_restore --list "$dump" > "$toc"
grep -Eq '^[0-9]+; [0-9]+ [0-9]+ TABLE [a-z_]+ users ' "$toc" || { log "the dump has no users table"; exit 1; }

step="upload"
log "uploading $(human "$size") to s3://$BACKUP_BUCKET/$key"
upload=(aws s3 cp --only-show-errors --no-progress --content-type application/octet-stream)
[ -z "$sse" ] || upload+=(--sse "$sse")
"${upload[@]}" "$dump" "s3://$BACKUP_BUCKET/$key"

step="upload check"
stored="$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$key" --query ContentLength --output text)"
[ "$stored" = "$size" ] || { log "stored size $stored differs from the dump's $size"; exit 1; }
if [ -n "$sse" ]; then
    encryption="$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$key" --query ServerSideEncryption --output text)"
    [ "$encryption" = "$sse" ] || { log "stored object is not encrypted with $sse (got $encryption)"; exit 1; }
fi

step="done"
echo "backup ok: s3://$BACKUP_BUCKET/$key ($(human "$size"), $(($(date +%s) - started)) s)"
