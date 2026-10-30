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

SECRET_KEYS='["APP_KEY","DB_PASSWORD","REDIS_PASSWORD","REVERB_APP_KEY","REVERB_APP_SECRET","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","TURNSTILE_SITE_KEY","TURNSTILE_SECRET","ADMIN_EMAILS","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID","POSTGRES_PASSWORD","MINIO_ROOT_PASSWORD","VAPID_PUBLIC_KEY","VAPID_PRIVATE_KEY"]'

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

    # Web Push: the VAPID pair from the Secret only, to the processes that use it; the subject in the ConfigMap.
    empty "$env: the VAPID private key is never in a ConfigMap, nor a literal value anywhere" \
        "$(yq e -N '(select(.kind == "ConfigMap") | .data | keys | .[] | select(test("VAPID_PRIVATE"))), (.. | select(tag == "!!map" and has("name") and has("value")) | select(.name | test("^VAPID_(PUBLIC|PRIVATE)_KEY$")) | .name)' "$file" | grep . || true)"
    expect "$env: the app and the queue worker read the VAPID pair from the Secret (optional: push off without it)" \
        "$(yq e -N 'select(.kind == "Deployment" and (.metadata.name == "slax-app" or .metadata.name == "slax-queue")) | .metadata.name + ":" + ([.spec.template.spec.containers[] | .env[]? | select(.name | test("^VAPID_")) | .valueFrom.secretKeyRef.name + "/" + .valueFrom.secretKeyRef.key + "/" + (.valueFrom.secretKeyRef.optional | tostring)] | join(","))' "$file" | grep . | sort | tr '\n' ' ')" \
        "slax-app:slax-secrets/VAPID_PUBLIC_KEY/true,slax-secrets/VAPID_PRIVATE_KEY/true slax-queue:slax-secrets/VAPID_PUBLIC_KEY/true,slax-secrets/VAPID_PRIVATE_KEY/true "
    expect "$env: the queue worker drains default (broadcasts) before push (Web Push)" \
        "$(yq e -N 'select(.kind == "Deployment" and .metadata.name == "slax-queue") | .spec.template.spec.containers[0].args | map(select(test("^--queue="))) | join(",")' "$file" | grep . || true)" \
        "--queue=default,push"
    empty "$env: Reverb and the monitor never get the VAPID pair" \
        "$(yq e -N 'select((.kind == "Deployment" and .metadata.name == "slax-reverb") or (.kind == "CronJob" and .metadata.name == "slax-monitor")) | .. | select(tag == "!!map" and has("name")) | select(.name | test("^VAPID_")) | .name' "$file" | grep . || true)"
    expect "$env: VAPID_SUBJECT is the public https URL unless push.subject says otherwise" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data.VAPID_SUBJECT' "$file")" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data.APP_URL' "$file")"

    # Sessions: 14 days, rolling, from session.lifetimeMinutes (a tapped notification must not land on sign-in).
    expect "$env: sessions in Redis, a guest's kept 2 hours at most (SESSION_DRIVER=redis-tiered)" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SESSION_DRIVER' "$file")" \
        "redis-tiered"
    expect "$env: sessions last 14 days, rolling (SESSION_LIFETIME=20160 from session.lifetimeMinutes; never expire on close)" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SESSION_LIFETIME + "/" + (.data.SESSION_EXPIRE_ON_CLOSE // "unset")' "$file")" \
        "20160/unset"
    expect "$env: the app, the queue worker and the scheduler read SESSION_LIFETIME from the ConfigMap" \
        "$(yq e -N 'select(.kind == "Deployment" and (.metadata.name == "slax-app" or .metadata.name == "slax-queue" or .metadata.name == "slax-scheduler")) | .metadata.name + ":" + ([.spec.template.spec.containers[] | .envFrom[]? | .configMapRef.name // ""] | join(","))' "$file" | sort | tr '\n' ' ')" \
        "slax-app:slax-config slax-queue:slax-config slax-scheduler:slax-config "
    expect "$env: the migration job gets the same SESSION_LIFETIME" \
        "$(yq e -N 'select(.kind == "Job") | .spec.template.spec.containers[].env[]? | select(.name == "SESSION_LIFETIME") | .value' "$file")" \
        "20160"

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
    expect "$env: Reverb (and its /apps/ HTTP API) is reachable from the Laravel pods and the uptime monitor only" \
        "$(yq ea -N 'select(.kind == "NetworkPolicy" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "reverb") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"]] | sort | join(",")' "$file")" \
        "app,monitor,queue,scheduler"
    empty "$env: no ingress routes to Reverb or under /app" \
        "$(yq ea -N 'select(.kind == "Ingress") | .spec.rules[].http.paths[] | select((.backend.service.name | test("reverb")) or (.path | test("^/apps?"))) | .path' "$file")"

    expect "$env: Reverb rate-limits every socket (300 frames/60 s, refused not cut), with no socket cap (a lockout vector)" \
        "$(yq ea -N 'select(.kind == "ConfigMap") | .data | [.REVERB_APP_RATE_LIMITING_ENABLED, .REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS, .REVERB_APP_RATE_LIMIT_DECAY_SECONDS, .REVERB_APP_RATE_LIMIT_TERMINATE, (has("REVERB_APP_MAX_CONNECTIONS") | tostring)] | join(",")' "$file")" \
        "true,300,60,false,false"
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

    empty "$env: no pod uses the host (hostPath, host network/PID/IPC) or runs privileged" \
        "$(yq e -N "$PODS"' | select((.spec.volumes // [] | any_c(has("hostPath"))) or .spec.hostNetwork == true or .spec.hostPID == true or .spec.hostIPC == true or ([.spec.containers[], (.spec.initContainers // [])[]] | any_c(.securityContext.privileged == true))) | .name' "$file")"
    empty "$env: the chart grants no Kubernetes API access (no Role, ClusterRole or binding)" \
        "$(yq ea -N 'select(.kind == "Role" or .kind == "ClusterRole" or .kind == "RoleBinding" or .kind == "ClusterRoleBinding") | .kind + "/" + .metadata.name' "$file")"

    # The uptime monitor (deploy/monitoring/uptime.sh): outside the app, every minute.
    expect "$env: the uptime monitor runs every minute, never two at once, each run ending within the minute" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | .spec.schedule + "/" + .spec.concurrencyPolicy + "/" + (.spec.startingDeadlineSeconds | tostring) + "/" + (.spec.jobTemplate.spec.backoffLimit | tostring) + "/" + ((.spec.jobTemplate.spec.activeDeadlineSeconds < 60) | tostring)' "$file")" \
        "* * * * */Forbid/30/0/true"
    # MONITOR_TIMEOUT, MONITOR_TELEGRAM_TIMEOUT, MONITOR_BUDGET_SECONDS, activeDeadlineSeconds
    budget="$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | .spec.jobTemplate.spec | ([.template.spec.containers[0].env[] | select(.name == "MONITOR_TIMEOUT" or .name == "MONITOR_TELEGRAM_TIMEOUT" or .name == "MONITOR_BUDGET_SECONDS") | .value] + [.activeDeadlineSeconds]) | join(" ")' "$file")"
    # shellcheck disable=SC2086 # four numbers
    set -- $budget
    expect "$env: the uptime monitor's worst case fits: checks (in parallel) + one alert + 5 s <= budget, budget + 15 s <= the Job's deadline ($budget)" \
        "$(($# == 4 && $1 + $2 + 5 <= $3 && $3 + 15 <= $4))" "1"
    expect "$env: the uptime monitor keeps one finished Job of each kind" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | (.spec.successfulJobsHistoryLimit | tostring) + "/" + (.spec.failedJobsHistoryLimit | tostring)' "$file")" \
        "1/1"
    expect "$env: the uptime monitor gets the alert keys only" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | [.spec.jobTemplate.spec.template.spec.containers[0].env[].valueFrom.secretKeyRef.key | select(. != null)] | sort | join(",")' "$file")" \
        "TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID"
    expect "$env: the uptime monitor mounts its own volume and an emptyDir, nothing else" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | [.spec.jobTemplate.spec.template.spec.volumes[] | .name + ":" + ([keys[] | select(. != "name")] | join("+")) + ":" + (.persistentVolumeClaim.claimName // "-")] | join(",")' "$file")" \
        "state:persistentVolumeClaim:slax-monitor,tmp:emptyDir:-"
    expect "$env: the uptime monitor watches the node's disk and the volumes' disk" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | .spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "MONITOR_DISKS") | .value' "$file")" \
        "node=/tmp volumes=/state"
    expect "$env: the uptime monitor alerts after 3 failures, disk above 80 % (6 h reminders, all clear below 75 %)" \
        "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | [.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "MONITOR_FAIL_THRESHOLD" or .name == "MONITOR_DISK_ALERT_PERCENT" or .name == "MONITOR_DISK_RECOVER_PERCENT" or .name == "MONITOR_DISK_REALERT_SECONDS") | .value] | join(",")' "$file")" \
        "3,80,75,21600"
    expect "$env: Helm never deletes the monitor's volume claim (the deployer may not delete claims)" \
        "$(yq ea -N 'select(.kind == "PersistentVolumeClaim") | .metadata.name + ":" + .metadata.annotations["helm.sh/resource-policy"]' "$file")" \
        "slax-monitor:keep"
    expect "$env: PostgreSQL and Redis admit the uptime monitor (no password given to it)" \
        "$(yq e -N 'select(.kind == "NetworkPolicy" and (.metadata.name == "slax-postgres" or .metadata.name == "slax-redis")) | .metadata.name + ":" + ([.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"] | select(. == "monitor")] | join(","))' "$file" | sort | tr '\n' ' ')" \
        "slax-postgres:monitor slax-redis:monitor "
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
expect "dev: the web pod admits the ingress controller and the uptime monitor only" \
    "$(yq ea -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-app") | [.spec.ingress[].from[].podSelector.matchLabels | (.["app.kubernetes.io/component"] // .["app.kubernetes.io/name"])] | join(",")' "$dev")" \
    "traefik,monitor"
expect "dev: MinIO's static keys are given to the Laravel pods" \
    "$(yq ea -N 'select(.kind == "Deployment" and .metadata.name == "slax-queue") | [.spec.template.spec.containers[0].env[].name | select(test("^AWS_"))] | join(",")' "$dev")" \
    "AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY"
empty "dev: no backup CronJob (no real S3)" "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name != "slax-monitor") | .metadata.name' "$dev")"
expect "dev: the uptime monitor checks the services inside the cluster, says [Dev]" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | .spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "MONITOR_CHECKS" or .name == "SLAX_ENV_LABEL") | .value' "$dev" | tr '\n' ' ')" \
    "Dev app=http://slax-app/api/v1/health reverb=http://slax-reverb:8080/up postgres=pg://slax-postgres:5432 redis=redis://slax-redis:6379 "

echo "== prod: Caddy on the host in front, real S3 through the instance role"
empty "prod: no Ingress (no ingress controller; Caddy on the host)" "$(yq ea -N 'select(.kind == "Ingress" or .kind == "Middleware") | .metadata.name' "$prod")"
expect "prod: the web Service has the fixed address Caddy proxies to (deploy/aws/Caddyfile)" \
    "$(yq ea -N 'select(.kind == "Service" and .metadata.name == "slax-app") | .spec.type + " " + .spec.clusterIP + ":" + (.spec.ports[0].port | tostring)' "$prod")" \
    "ClusterIP 10.43.0.80:80"
caddy_upstream="$(grep -Eo 'SLAX_UPSTREAM:[0-9.]+:[0-9]+' deploy/aws/Caddyfile 2>/dev/null | head -1)"
expect "prod: the Caddyfile's default upstream is that address" "$caddy_upstream" "SLAX_UPSTREAM:10.43.0.80:80"
expect "prod: no pod may connect to the web pod but the uptime monitor (otherwise only the node: Caddy, probes)" \
    "$(yq e -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-app") | (.spec.policyTypes | join(",")) + "/" + ([.spec.ingress[].from[] | (.podSelector.matchLabels["app.kubernetes.io/component"] // "other") + "+namespaces:" + ((.namespaceSelector != null) | tostring)] | join(",")) + "/" + ([.spec.ingress[].ports[].port] | join(","))' "$prod")" \
    "Ingress/monitor+namespaces:false/8080"
expect "prod: the uptime monitor also checks the public URL (DNS, Caddy, TLS), says [Prod]" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-monitor") | .spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "MONITOR_CHECKS" or .name == "SLAX_ENV_LABEL") | .value' "$prod" | tr '\n' ' ')" \
    "Prod app=http://slax-app/api/v1/health reverb=http://slax-reverb:8080/up postgres=pg://slax-postgres:5432 redis=redis://slax-redis:6379 public=https://slax.yechpa.com/api/v1/health "
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
    "migrate:169.254.169.254/32 monitor:169.254.169.254/32 postgres:169.254.169.254/32 redis:169.254.169.254/32 reverb:169.254.169.254/32 scanner:none "
expect "prod: the app's scheduler knows the backups bucket (backups:check-freshness)" \
    "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_BACKUP_BUCKET + " " + .data.SLAX_BACKUP_PREFIX' "$prod")" \
    "slax-backups-example pg"
empty "dev: no backups bucket configured" "$(yq ea -N 'select(.kind == "ConfigMap") | .data.SLAX_BACKUP_BUCKET // ""' "$dev")"
expect "prod: the Service address is in the static band (10.43.0.0-10.43.0.255), not .1 or .10" \
    "$(yq e -N 'select(.kind == "Service" and .metadata.name == "slax-app") | .spec.clusterIP' "$prod" | grep -Ex '10\.43\.0\.([1-9]?[0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])' | grep -vEx '10\.43\.0\.(0|1|10)' | sed 's/.*/true/')" \
    "true"
expect "prod: daily backup at 02:30 and weekly restore check Sunday 03:30, Jerusalem time, never overlapping" \
    "$(yq e -N 'select(.kind == "CronJob" and .metadata.name != "slax-monitor") | .metadata.name + "=" + .spec.schedule + "@" + .spec.timeZone + "/" + .spec.concurrencyPolicy' "$prod" | sort | tr '\n' ' ')" \
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
expect "prod: PostgreSQL admits the backup and the uptime monitor (not the restore check)" \
    "$(yq ea -N 'select(.kind == "NetworkPolicy" and .metadata.name == "slax-postgres") | [.spec.ingress[].from[].podSelector.matchLabels["app.kubernetes.io/component"] | select(. != null)] | join(",")' "$prod")" \
    "backup,monitor"
expect "prod: backups need the instance role: credentials from IMDS, region set, HOME writable" \
    "$(yq ea -N 'select(.kind == "CronJob" and .metadata.name == "slax-backup") | [.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "AWS_REGION" or .name == "HOME" or .name == "BACKUP_BUCKET") | .name + "=" + .value] | join(",")' "$prod")" \
    "BACKUP_BUCKET=slax-backups-example,AWS_REGION=eu-central-1,HOME=/tmp"

if [ "$failures" -gt 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "All chart checks passed"
