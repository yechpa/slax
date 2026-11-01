#!/usr/bin/env bash
# Creates the Kubernetes Secret every Slax pod reads (slax-secrets in namespace slax), on the
# cluster's own machine, with the cluster admin's kubectl. Nothing is ever written to the
# repository, shown on screen or passed on a command line: values are generated here or typed
# at hidden prompts, kept in a private temporary directory, handed to kubectl as files, then
# deleted.
#
#   sudo deploy/dev/create-secrets.sh             create it (refuses if it already exists)
#   sudo deploy/dev/create-secrets.sh set KEY     replace one key (hidden prompt)
#   sudo deploy/dev/create-secrets.sh vapid       new Web Push key pair (rotation: every device
#                                                 has to turn notifications on again)
#
# Environment: NAMESPACE (slax), SECRET_NAME (slax-secrets), KUBECTL ("k3s kubectl"),
# S3_KEYS=generate (dev: keys for the in-cluster MinIO), none (production: the EC2 instance
# role, no key at all; values-prod.yaml s3.useInstanceRole) or ask (static keys for real S3).
# KUBECTL must not be the bare word "kubectl": the function below has that name and would call itself
# until the shell crashes; use a full path such as /usr/local/bin/kubectl.
#
# Generated: APP_KEY, DB_PASSWORD, REDIS_PASSWORD, REVERB_APP_KEY, REVERB_APP_SECRET, the Web Push
# pair VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (PUSH_KEYS=none to leave push off) and, with
# S3_KEYS=generate, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (hexadecimal: URL- and
# config-file-safe). Asked: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TURNSTILE_SITE_KEY,
# TURNSTILE_SECRET; optional (Enter to skip): ADMIN_EMAILS, TELEGRAM_BOT_TOKEN,
# TELEGRAM_CHAT_ID.
#
# DB_PASSWORD and REDIS_PASSWORD are fixed when PostgreSQL first starts: never regenerate them
# on a running cluster (`set` changes the Secret, not the database's password).
set -euo pipefail

NAMESPACE="${NAMESPACE:-slax}"
SECRET_NAME="${SECRET_NAME:-slax-secrets}"
KUBECTL="${KUBECTL:-k3s kubectl}"
S3_KEYS="${S3_KEYS:-generate}"
PUSH_KEYS="${PUSH_KEYS:-generate}"

dir="$(mktemp -d)"
chmod 700 "$dir"
trap 'rm -rf "$dir"' EXIT
umask 077

kubectl() { $KUBECTL "$@"; }

# ask KEY [optional]: hidden prompt, value into $dir/KEY (an empty optional answer: no key).
ask() {
    local key="$1" optional="${2:-}" value=""
    while :; do
        read -r -s -p "$key${optional:+ (optional, Enter to skip)}: " value || { echo "No input for $key" >&2; exit 1; }
        echo >&2
        if [ -n "$value" ] || [ -n "$optional" ]; then break; fi
        echo "  $key is required." >&2
    done
    [ -z "$value" ] || printf '%s' "$value" > "$dir/$key"
}

# generate KEY BYTES: random hexadecimal value.
generate() {
    openssl rand -hex "$2" | tr -d '\n' > "$dir/$1"
}

b64url() {
    base64 | tr -d '\n=' | tr '+/' '-_'
}

# vapid: a P-256 key pair for Web Push into $dir/VAPID_PUBLIC_KEY and $dir/VAPID_PRIVATE_KEY,
# base64url, the format of `php artisan slax:push-keys` (minishlink/web-push): the public key is
# the uncompressed point (65 bytes), the private key the scalar (32 bytes). Made here with
# openssl because the Secret exists before any Slax pod does. Read from the key's SEC1 DER
# encoding, a fixed 121-byte layout for P-256, and checked against openssl's own public key.
vapid() {
    local der="$dir/vapid.der"
    openssl ecparam -name prime256v1 -genkey -noout -outform DER -out "$der"
    [ "$(wc -c < "$der")" -eq 121 ] || { echo "Unexpected P-256 key encoding" >&2; exit 1; }
    head -c 39 "$der" | tail -c 32 | b64url > "$dir/VAPID_PRIVATE_KEY"
    tail -c 65 "$der" | b64url > "$dir/VAPID_PUBLIC_KEY"
    [ "$(openssl ec -inform DER -in "$der" -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)" = "$(cat "$dir/VAPID_PUBLIC_KEY")" ] \
        || { echo "VAPID public key mismatch" >&2; exit 1; }
    rm -f "$der"
}

if [ "${1:-}" = set ]; then
    key="${2:?usage: $0 set KEY}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Not a key name: $key" >&2; exit 1; }
    ask "$key"
    printf '{"data":{"%s":"%s"}}' "$key" "$(base64 -w0 < "$dir/$key")" > "$dir/patch.json"
    kubectl -n "$NAMESPACE" patch secret "$SECRET_NAME" --type merge --patch-file "$dir/patch.json" >/dev/null
    echo "Updated $key in $NAMESPACE/$SECRET_NAME. Restart the pods to use it:"
    echo "  $KUBECTL -n $NAMESPACE rollout restart deployment"
    exit 0
fi

if [ "${1:-}" = vapid ]; then
    vapid
    printf '{"data":{"VAPID_PUBLIC_KEY":"%s","VAPID_PRIVATE_KEY":"%s"}}' \
        "$(base64 -w0 < "$dir/VAPID_PUBLIC_KEY")" "$(base64 -w0 < "$dir/VAPID_PRIVATE_KEY")" > "$dir/patch.json"
    kubectl -n "$NAMESPACE" patch secret "$SECRET_NAME" --type merge --patch-file "$dir/patch.json" >/dev/null
    echo "New VAPID pair in $NAMESPACE/$SECRET_NAME. Every device must turn notifications on again. Restart the pods:"
    echo "  $KUBECTL -n $NAMESPACE rollout restart deployment"
    exit 0
fi

if kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
    echo "$NAMESPACE/$SECRET_NAME already exists. Change one key with: $0 set KEY" >&2
    exit 1
fi

printf 'base64:%s' "$(openssl rand -base64 32)" > "$dir/APP_KEY"
generate DB_PASSWORD 24
generate REDIS_PASSWORD 24
generate REVERB_APP_KEY 16
generate REVERB_APP_SECRET 32
case "$S3_KEYS" in
    generate)
        generate AWS_ACCESS_KEY_ID 10
        generate AWS_SECRET_ACCESS_KEY 20
        ;;
    ask)
        ask AWS_ACCESS_KEY_ID
        ask AWS_SECRET_ACCESS_KEY
        ;;
    none) ;;
    *) echo "S3_KEYS must be generate, none or ask" >&2; exit 1 ;;
esac
case "$PUSH_KEYS" in
    generate) vapid ;;
    none) ;;
    *) echo "PUSH_KEYS must be generate or none" >&2; exit 1 ;;
esac

echo "Values are read without echo. Paste each one, then Enter." >&2
ask GOOGLE_CLIENT_ID
ask GOOGLE_CLIENT_SECRET
ask TURNSTILE_SITE_KEY
ask TURNSTILE_SECRET
ask ADMIN_EMAILS optional
ask TELEGRAM_BOT_TOKEN optional
ask TELEGRAM_CHAT_ID optional

kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" --from-file="$dir" >/dev/null
echo "Created $NAMESPACE/$SECRET_NAME with keys:"
ls "$dir" | sed 's/^/  /'
