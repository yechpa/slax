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

# Every workload's pod: {name, spec}.
PODS='select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "Job" or .kind == "CronJob") | {"name": .metadata.name, "spec": (.spec.jobTemplate.spec.template.spec // .spec.template.spec)}'

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

    # Pod specs of every workload: Deployments, StatefulSets, Jobs and CronJobs.
    empty "$env: every pod runs as non-root with the RuntimeDefault seccomp profile and no API token" \
        "$(yq ea -N "$PODS"' | select(.spec.securityContext.runAsNonRoot != true or .spec.securityContext.seccompProfile.type != "RuntimeDefault" or .spec.automountServiceAccountToken != false) | .name' "$file")"
    empty "$env: every container: non-root, no privilege escalation, read-only root filesystem, no capability, limits" \
        "$(yq e -N "$PODS"' | .name as $w | .spec | (.containers + (.initContainers // []))[] | select(.securityContext.runAsNonRoot != true or .securityContext.allowPrivilegeEscalation != false or .securityContext.readOnlyRootFilesystem != true or ((.securityContext.capabilities.drop // []) | any_c(. == "ALL") | not) or .resources.requests.memory == null or .resources.limits.memory == null) | $w + "/" + .name' "$file")"

    empty "$env: images are the release's own (ghcr.io/yechpa/slax-*:<tag>) or pinned by digest" \
        "$(yq ea -N '.. | select(tag == "!!map" and has("image")) | .image | select((test("^ghcr\.io/yechpa/slax-(app|web|scanner|backup):0123abc$") or test("@sha256:[0-9a-f]{64}$")) | not)' "$file")"
    expect "$env: nginx believes X-Forwarded-For from the k3s pod network only" \
        "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-app") | .spec.template.spec.containers[] | select(.name == "web") | .env[] | select(.name == "SLAX_TRUSTED_PROXIES") | .value' "$file")" \
        "10.42.0.0/16"
    expect "$env: no HSTS from nginx (the TLS terminator in front sets it)" \
        "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-app") | .spec.template.spec.containers[] | select(.name == "web") | .env[] | select(.name == "SLAX_HSTS_MAX_AGE") | .value' "$file")" \
        "0"
    empty "$env: Laravel is never told to trust proxies itself (nginx resolves the client address)" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data | keys | .[] | select(test("TRUST"))' "$file")"

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

    expect "$env: Reverb gets only its own secrets, Redis's and the alert keys" \
        "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-reverb") | [.spec.template.spec.containers[0].env[].valueFrom.secretKeyRef.key] | sort | join(",")' "$file")" \
        "REDIS_PASSWORD,REVERB_APP_KEY,REVERB_APP_SECRET,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID"
    expect "$env: PostgreSQL is reachable from the Laravel processes with database access only" \
        "$(yq ea -N '[select((.kind == "Deployment" or .kind == "Job") and .spec.template.metadata.labels["slax.yechpa.com/backend"] == "true") | .metadata.name] | sort | join(",")' "$file")" \
        "slax-app,slax-migrate,slax-queue,slax-scheduler"
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

echo "== dev: Traefik in front"
expect "dev: the app's ingress sends / to the web pod only" \
    "$(yq ea -N 'select(.kind == "Ingress" and .metadata.name == "slax") | [.spec.rules[].http.paths[] | .path + ">" + .backend.service.name] | join(",")' "$dev")" \
    "/>slax-app"
expect "dev: the web pod admits the ingress controller only" \
    "$(yq ea -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-app") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/name"]] | join(",")' "$dev")" \
    "traefik"
expect "dev: MinIO's static keys are given to the Laravel pods" \
    "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-queue") | [.spec.template.spec.containers[0].env[].name | select(test("^AWS_"))] | join(",")' "$dev")" \
    "AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY"
empty "dev: no backup CronJob (no real S3)" "$(yq ea -N 'select(.kind == "CronJob") | .metadata.name' "$dev")"

echo "== prod: Caddy on the host in front, real S3 through the instance role"
empty "prod: no Ingress (no ingress controller; Caddy on the host)" "$(yq ea -N 'select(.kind == "Ingress" or .kind == "Middleware") | .metadata.name' "$prod")"
expect "prod: the web Service has the fixed address Caddy proxies to (deploy/aws/Caddyfile)" \
    "$(yq ea -N 'select(.kind == "Service" and .metadata.name == "slax-app") | .spec.type + " " + .spec.clusterIP + ":" + (.spec.ports[0].port | tostring)' "$prod")" \
    "ClusterIP 10.43.0.80:80"
caddy_upstream="$(grep -Eo 'SLAX_UPSTREAM:[0-9.]+:[0-9]+' deploy/aws/Caddyfile 2>/dev/null | head -1)"
expect "prod: the Caddyfile's default upstream is that address" "$caddy_upstream" "SLAX_UPSTREAM:10.43.0.80:80"
expect "prod: no pod may connect to the web pod (only the node: Caddy, probes)" \
    "$(yq ea -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-app") | (.spec.policyTypes | join(",")) + "/" + (.spec.ingress | length | tostring)' "$prod")" \
    "Ingress/0"
empty "prod: no static AWS key anywhere (instance role)" \
    "$(yq ea -N '.. | select(tag == "!!map" and has("name")) | .name | select(test("^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$"))' "$prod")"
expect "prod: S3 on AWS itself in eu-central-1 (no endpoint override)" \
    "$(yq ea -N 'select(.kind == "ConfigMap") | .data.AWS_DEFAULT_REGION + " " + .data.AWS_BUCKET + " " + (.data.AWS_ENDPOINT // "-") + " " + (.data.AWS_PUBLIC_ENDPOINT // "-") + " " + .data.AWS_USE_PATH_STYLE_ENDPOINT' "$prod")" \
    "eu-central-1 slax-files-example - - false"
expect "prod: previews come from the bucket's own host (CSP img-src = presigned URL host)" \
    "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-app") | .spec.template.spec.containers[] | select(.name == "web") | .env[] | select(.name == "SLAX_FILES_ORIGIN") | .value' "$prod")" \
    "https://slax-files-example.s3.eu-central-1.amazonaws.com"
expect "prod: only app, queue, scheduler, backup and restore-check may reach the instance metadata service" \
    "$(yq e -N 'select(.kind == "NetworkPolicy" and (.spec.policyTypes | any_c(. == "Egress"))) | .spec.podSelector.matchLabels["app.kubernetes.io/component"] + ":" + ((.spec.egress[0].to[0].ipBlock.except // ["none"]) | join(","))' "$prod" | sort | tr '\n' ' ')" \
    "migrate:169.254.169.254/32 postgres:169.254.169.254/32 redis:169.254.169.254/32 reverb:169.254.169.254/32 scanner:none "
expect "prod: the app's scheduler knows the backups bucket (backups:check-freshness)" \
    "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_BACKUP_BUCKET + " " + .data.SLAX_BACKUP_PREFIX' "$prod")" \
    "slax-backups-example pg"
empty "dev: no backups bucket configured" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_BACKUP_BUCKET // ""' "$dev")"
expect "prod: the Service address is in the static band (10.43.0.0-10.43.0.255), not .1 or .10" \
    "$(yq e -N 'select(.kind == "Service" and .metadata.name == "slax-app") | .spec.clusterIP' "$prod" | grep -Ex '10\.43\.0\.([1-9]?[0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])' | grep -vEx '10\.43\.0\.(0|1|10)' | sed 's/.*/true/')" \
    "true"
expect "prod: daily backup at 02:30 and weekly restore check Sunday 03:30, Jerusalem time, never overlapping" \
    "$(yq e -N 'select(.kind == "CronJob") | .metadata.name + "=" + .spec.schedule + "@" + .spec.timeZone + "/" + .spec.concurrencyPolicy' "$prod" | sort | tr '\n' ' ')" \
    "slax-backup=30 2 * * *@Asia/Jerusalem/Forbid slax-restore-check=30 3 * * 0@Asia/Jerusalem/Forbid "
expect "prod: the backup gets the database password and the alert keys only" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-backup") | [.spec.jobTemplate.spec.template.spec.containers[0].env[].valueFrom.secretKeyRef.key | select(. != null)] | sort | join(",")' "$prod")" \
    "DB_PASSWORD,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID"
expect "prod: the restore check gets the alert keys only" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-restore-check") | [.spec.jobTemplate.spec.template.spec | (.containers + .initContainers)[] | .env[].valueFrom.secretKeyRef.key | select(. != null)] | sort | join(",")' "$prod")" \
    "TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID"
expect "prod: the restore check's throwaway PostgreSQL is a sidecar on the pod's loopback" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-restore-check") | .spec.jobTemplate.spec.template.spec.initContainers[0] | .restartPolicy + " " + (.args | join(" ") | test("listen_addresses=127.0.0.1") | tostring)' "$prod")" \
    "Always true"
expect "prod: PostgreSQL admits the backup (not the restore check)" \
    "$(yq ea -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-postgres") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"] | select(. != null)] | join(",")' "$prod")" \
    "backup"
expect "prod: backups need the instance role: credentials from IMDS, region set, HOME writable" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-backup") | [.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "AWS_REGION" or .name == "HOME" or .name == "BACKUP_BUCKET") | .name + "=" + .value] | join(",")' "$prod")" \
    "BACKUP_BUCKET=slax-backups-example,AWS_REGION=eu-central-1,HOME=/tmp"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All chart checks passed"
