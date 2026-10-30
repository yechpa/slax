#!/bin/sh
# Assertions on the rendered chart (`make chart-lint` runs it in the yq image):
#   check-chart.sh <dev render> <prod render>
# Each check states a rule of the deployment; any failure exits non-zero.
set -eu

dev="$1"
prod="$2"
failures=0

fail() {
    echo "FAIL: $*"
    failures=$((failures + 1))
}

pass() {
    echo "ok:   $*"
}

# expect <description> <actual> <expected>
expect() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi
}

# empty <description> <output that must be empty>
empty() {
    if [ -z "$2" ]; then pass "$1"; else fail "$1: $(echo "$2" | tr '\n' ' ')"; fi
}

SECRET_KEYS='["APP_KEY","DB_PASSWORD","REDIS_PASSWORD","REVERB_APP_KEY","REVERB_APP_SECRET","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","TURNSTILE_SITE_KEY","TURNSTILE_SECRET","ADMIN_EMAILS","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","POSTGRES_PASSWORD","MINIO_ROOT_PASSWORD"]'

for env in dev prod; do
    eval "file=\$$env"
    echo "== $env ($file)"

    expect "$env: every Laravel process runs APP_ENV=production" \
        "$(yq ea -N '[.. | select(tag == "!!map" and .APP_ENV != null) | .APP_ENV] + [.. | select(tag == "!!map" and .name == "APP_ENV") | .value] | unique | join(",")' "$file")" \
        "production"
    expect "$env: APP_DEBUG=false" \
        "$(yq ea -N '[.. | select(tag == "!!map" and .APP_DEBUG != null) | .APP_DEBUG] + [.. | select(tag == "!!map" and .name == "APP_DEBUG") | .value] | unique | join(",")' "$file")" \
        "false"
    expect "$env: errors reach Telegram (LOG_CHANNEL=stack, LOG_STACK=stderr,telegram)" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data.LOG_CHANNEL + " " + .data.LOG_STACK' "$file")" \
        "stack stderr,telegram"

    empty "$env: the chart creates no Secret (referenced by name only)" \
        "$(yq ea -N 'select(.kind == "Secret") | .metadata.name' "$file")"
    empty "$env: no secret key has a literal value" \
        "$(yq ea -N "[.. | select(tag == \"!!map\" and has(\"name\") and has(\"value\")) | select(.name as \$n | $SECRET_KEYS | any_c(. == \$n)) | .name] | .[]" "$file")"
    empty "$env: no secret key in the ConfigMap" \
        "$(yq ea -N "select(.kind == \"ConfigMap\") | .data | keys | .[] | select(. as \$k | $SECRET_KEYS | any_c(. == \$k))" "$file")"

    empty "$env: every pod runs as non-root with the RuntimeDefault seccomp profile and no API token" \
        "$(yq ea -N 'select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "Job") | select(.spec.template.spec.securityContext.runAsNonRoot != true or .spec.template.spec.securityContext.seccompProfile.type != "RuntimeDefault" or .spec.template.spec.automountServiceAccountToken != false) | .metadata.name' "$file")"
    empty "$env: every container: non-root, no privilege escalation, read-only root filesystem, no capability, limits" \
        "$(yq e -N 'select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "Job") | .metadata.name as $w | .spec.template.spec | (.containers + (.initContainers // []))[] | select(.securityContext.runAsNonRoot != true or .securityContext.allowPrivilegeEscalation != false or .securityContext.readOnlyRootFilesystem != true or ((.securityContext.capabilities.drop // []) | any_c(. == "ALL") | not) or .resources.requests.memory == null or .resources.limits.memory == null) | $w + "/" + .name' "$file")"

    empty "$env: images are the release's own (ghcr.io/yechpa/slax-*:<tag>) or pinned by digest" \
        "$(yq ea -N '.. | select(tag == "!!map" and has("image")) | .image | select((test("^ghcr\.io/yechpa/slax-(app|web|scanner):0123abc$") or test("@sha256:[0-9a-f]{64}$")) | not)' "$file")"

    expect "$env: the scanner is reachable from the app and queue pods only" \
        "$(yq ea -N 'select(.kind == "NetworkPolicy" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "scanner") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"]] | sort | join(",")' "$file")" \
        "app,queue"
    expect "$env: the scanner reaches nothing (egress denied)" \
        "$(yq ea -N 'select(.kind == "NetworkPolicy" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "scanner") | (.spec.policyTypes | any_c(. == "Egress")) + "/" + (.spec.egress | length)' "$file")" \
        "true/0"
    expect "$env: the scanner Service is ClusterIP" \
        "$(yq ea -N 'select(.kind == "Service" and .metadata.name == "slax-scanner") | .spec.type' "$file")" \
        "ClusterIP"
    expect "$env: Reverb (and its /apps/ HTTP API) is reachable from the Laravel pods only" \
        "$(yq ea -N 'select(.kind == "NetworkPolicy" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "reverb") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"]] | sort | join(",")' "$file")" \
        "app,queue,scheduler"
    empty "$env: no ingress routes to Reverb or under /app" \
        "$(yq ea -N 'select(.kind == "Ingress") | .spec.rules[].http.paths[] | select((.backend.service.name | test("reverb")) or (.path | test("^/apps?"))) | .path' "$file")"
    expect "$env: the app's ingress sends / to the web pod only" \
        "$(yq ea -N 'select(.kind == "Ingress" and .metadata.name == "slax") | [.spec.rules[].http.paths[] | .path + ">" + .backend.service.name] | join(",")' "$file")" \
        "/>slax-app"

    expect "$env: Reverb, queue and scheduler run once, never two side by side" \
        "$(yq ea -N 'select(.kind == "Deployment" and (.metadata.name == "slax-reverb" or .metadata.name == "slax-queue" or .metadata.name == "slax-scheduler")) | .spec.replicas + "/" + .spec.strategy.type' "$file" | sort -u | tr '\n' ' ')" \
        "1/Recreate "
    expect "$env: migrations run before an upgrade (and after the first install)" \
        "$(yq ea -N 'select(.kind == "Job" and .metadata.name == "slax-migrate") | .metadata.annotations["helm.sh/hook"]' "$file")" \
        "post-install,pre-upgrade"
    expect "$env: migrations seed the default workspace" \
        "$(yq ea -N 'select(.kind == "Job" and .metadata.name == "slax-migrate") | .spec.template.spec.containers[0].args[2] | test("db:seed --class=DefaultWorkspaceSeeder --force")' "$file")" \
        "true"
done

echo "== dev and prod differences"
expect "dev: alerts say [Dev]" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_ENV_LABEL' "$dev")" "Dev"
expect "prod: alerts say [Prod]" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_ENV_LABEL' "$prod")" "Prod"
expect "dev: no nightly demo reset" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_DEMO_RESET_ENABLED' "$dev")" "false"
expect "prod (the public showcase): nightly demo reset" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_DEMO_RESET_ENABLED' "$prod")" "true"
expect "dev: MinIO is deployed" "$(yq ea -N 'select(.kind == "StatefulSet" and .metadata.name == "slax-minio") | .metadata.name' "$dev")" "slax-minio"
empty "prod: no MinIO anywhere (real S3)" "$(grep -i minio "$prod" || true)"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All chart checks passed"
