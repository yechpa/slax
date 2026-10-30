{{/*
Names. Every object is "<release>-<component>" (release "slax": slax-app, slax-reverb, ...).
*/}}
{{- define "slax.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "slax.name" -}}
{{- printf "%s-%s" (include "slax.fullname" .ctx) .component -}}
{{- end -}}

{{- define "slax.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: slax
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: slax
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | quote }}
{{- end -}}

{{/* Selector labels of one component: (dict "ctx" $ "component" "app") */}}
{{- define "slax.selectorLabels" -}}
app.kubernetes.io/name: slax
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "slax.componentLabels" -}}
{{ include "slax.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Pods running the Laravel code with database access (app, queue, scheduler, migrations) carry
this label: the network policies let only them reach PostgreSQL, Redis and MinIO (Reverb, which
needs only Redis, is let into Redis by name).
*/}}
{{- define "slax.backendLabel" -}}
slax.yechpa.com/backend: "true"
{{- end -}}

{{/* ghcr.io/yechpa/slax-<name>:<tag>. (dict "ctx" $ "name" "app") */}}
{{- define "slax.image" -}}
{{- $v := .ctx.Values.image -}}
{{- $tag := required "image.tag is required: --set image.tag=<git commit SHA>" $v.tag -}}
{{- printf "%s/%s/slax-%s:%s" $v.registry $v.owner .name $tag -}}
{{- end -}}

{{- define "slax.publicHost" -}}
{{- required "publicHost is required (e.g. dev.slax.yechpa.com)" .Values.publicHost -}}
{{- end -}}

{{- define "slax.publicUrl" -}}
{{- printf "https://%s" (include "slax.publicHost" .) -}}
{{- end -}}

{{/* S3 endpoint the app uses: the in-cluster MinIO when enabled, else s3.endpoint (empty: AWS). */}}
{{- define "slax.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}
{{- printf "http://%s:9000" (include "slax.name" (dict "ctx" . "component" "minio")) -}}
{{- else -}}
{{- .Values.s3.endpoint -}}
{{- end -}}
{{- end -}}

{{/* Endpoint in presigned download URLs (what browsers reach). */}}
{{- define "slax.s3PublicEndpoint" -}}
{{- if .Values.s3.publicEndpoint -}}
{{- .Values.s3.publicEndpoint -}}
{{- else if .Values.minio.enabled -}}
{{- printf "https://%s" (required "minio.ingress.host is required with MinIO" .Values.minio.ingress.host) -}}
{{- end -}}
{{- end -}}

{{/* Origin file previews load from (CSP img-src): s3.filesOrigin, else the public endpoint's origin. */}}
{{- define "slax.filesOrigin" -}}
{{- if .Values.s3.filesOrigin -}}
{{- .Values.s3.filesOrigin -}}
{{- else -}}
{{- regexFind "^https?://[^/]+" (include "slax.s3PublicEndpoint" .) -}}
{{- end -}}
{{- end -}}

{{/*
Non-secret configuration of the Laravel processes, as a YAML map. Used by the ConfigMap and,
inline, by the migration Job (a pre-upgrade hook runs before the ConfigMap is updated).
APP_ENV and APP_DEBUG are fixed: every cluster runs production code paths (never local/e2e).
*/}}
{{- define "slax.config" -}}
{{- $host := include "slax.publicHost" . -}}
{{- $url := include "slax.publicUrl" . -}}
{{- $s3Endpoint := include "slax.s3Endpoint" . -}}
{{- $s3PublicEndpoint := include "slax.s3PublicEndpoint" . -}}
APP_NAME: Slax
APP_ENV: production
APP_DEBUG: "false"
APP_URL: {{ $url | quote }}
LOG_CHANNEL: stack
LOG_STACK: "stderr,telegram"
LOG_LEVEL: {{ .Values.config.logLevel | quote }}
DB_CONNECTION: pgsql
DB_HOST: {{ include "slax.name" (dict "ctx" . "component" "postgres") | quote }}
DB_PORT: "5432"
DB_DATABASE: {{ .Values.postgres.database | quote }}
DB_USERNAME: {{ .Values.postgres.username | quote }}
REDIS_CLIENT: phpredis
REDIS_HOST: {{ include "slax.name" (dict "ctx" . "component" "redis") | quote }}
REDIS_PORT: "6379"
SESSION_DRIVER: redis
SESSION_SECURE_COOKIE: "true"
CACHE_STORE: redis
QUEUE_CONNECTION: redis
BROADCAST_CONNECTION: reverb
REVERB_APP_ID: {{ .Values.reverb.appId | quote }}
REVERB_HOST: {{ include "slax.name" (dict "ctx" . "component" "reverb") | quote }}
REVERB_PORT: "8080"
REVERB_SCHEME: http
REVERB_SERVER_HOST: "0.0.0.0"
REVERB_SERVER_PORT: "8080"
REVERB_MAX_REQUEST_SIZE: "131072"
REVERB_ALLOWED_ORIGINS: {{ $host | quote }}
AWS_DEFAULT_REGION: {{ .Values.s3.region | quote }}
AWS_BUCKET: {{ .Values.s3.bucket | quote }}
AWS_USE_PATH_STYLE_ENDPOINT: {{ ternary "true" "false" (or .Values.minio.enabled .Values.s3.usePathStyle) | quote }}
{{- with $s3Endpoint }}
AWS_ENDPOINT: {{ . | quote }}
{{- end }}
{{- with $s3PublicEndpoint }}
AWS_PUBLIC_ENDPOINT: {{ . | quote }}
{{- end }}
SCANNER_URL: {{ printf "http://%s:8000" (include "slax.name" (dict "ctx" . "component" "scanner")) | quote }}
GOOGLE_REDIRECT_URI: {{ printf "%s/auth/google/callback" $url | quote }}
SANCTUM_STATEFUL_DOMAINS: {{ $host | quote }}
SLAX_ENV_LABEL: {{ required "envLabel is required (Dev or Prod)" .Values.envLabel | quote }}
SLAX_DEMO_RESET_ENABLED: {{ ternary "true" "false" .Values.demo.resetEnabled | quote }}
SLAX_AUDIT_RETENTION_DAYS: {{ .Values.config.auditRetentionDays | quote }}
{{- range $key, $value := .Values.config.extraEnv }}
{{- if has $key (list "APP_ENV" "APP_DEBUG" "APP_KEY") }}
{{- fail (printf "config.extraEnv cannot set %s" $key) }}
{{- end }}
{{- if has $key (concat (include "slax.secretKeys" $ | fromYamlArray) (include "slax.optionalSecretKeys" $ | fromYamlArray)) }}
{{- fail (printf "config.extraEnv cannot set %s: it is a secret (%s)" $key $.Values.secretName) }}
{{- end }}
{{ $key }}: {{ $value | quote }}
{{- end }}
{{- end -}}

{{/* Keys of the hand-made Secret (secretName) the Laravel processes read. Required ones first. */}}
{{- define "slax.secretKeys" -}}
- APP_KEY
- DB_PASSWORD
- REDIS_PASSWORD
- REVERB_APP_KEY
- REVERB_APP_SECRET
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- TURNSTILE_SECRET
{{- end -}}

{{/* Optional: alerts are off without the Telegram pair; no administrator without ADMIN_EMAILS. */}}
{{- define "slax.optionalSecretKeys" -}}
- ADMIN_EMAILS
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
{{- end -}}

{{- define "slax.secretRef" -}}
- name: {{ .key }}
  valueFrom:
    secretKeyRef:
      name: {{ .ctx.Values.secretName }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{/* env: entries of the Laravel processes' secrets. */}}
{{- define "slax.backendSecretEnv" -}}
{{- range $key := include "slax.secretKeys" . | fromYamlArray }}
{{ include "slax.secretRef" (dict "ctx" $ "key" $key) }}
{{- end }}
{{- range $key := include "slax.optionalSecretKeys" . | fromYamlArray }}
{{ include "slax.secretRef" (dict "ctx" $ "key" $key "optional" true) }}
{{- end }}
{{- end -}}

{{- define "slax.podSecurityContext" -}}
runAsNonRoot: true
fsGroup: {{ . }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Every container: unprivileged, no capability, read-only root filesystem. Argument: the uid. */}}
{{- define "slax.containerSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ . }}
runAsGroup: {{ . }}
allowPrivilegeEscalation: false
privileged: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Pod fields shared by every workload. */}}
{{- define "slax.podCommon" -}}
serviceAccountName: {{ include "slax.fullname" . }}
automountServiceAccountToken: false
enableServiceLinks: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
A Laravel process of the slax-app image: (dict "ctx" $ "name" "queue" "args" (list ...)
"resources" {...}). The configuration from the ConfigMap, the secrets by key (all of them, or
only "secretKeys" and "optionalSecretKeys" when given), writable storage/ and /tmp as emptyDir
volumes.
*/}}
{{- define "slax.phpContainer" -}}
- name: {{ .name }}
  image: {{ include "slax.image" (dict "ctx" .ctx "name" "app") }}
  imagePullPolicy: {{ .ctx.Values.image.pullPolicy }}
  {{- with .args }}
  args:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  envFrom:
    - configMapRef:
        name: {{ include "slax.name" (dict "ctx" .ctx "component" "config") }}
  env:
    {{- if .secretKeys }}
    {{- range $key := .secretKeys }}
    {{- include "slax.secretRef" (dict "ctx" $.ctx "key" $key) | nindent 4 }}
    {{- end }}
    {{- range $key := .optionalSecretKeys }}
    {{- include "slax.secretRef" (dict "ctx" $.ctx "key" $key "optional" true) | nindent 4 }}
    {{- end }}
    {{- else }}
    {{- include "slax.backendSecretEnv" .ctx | trim | nindent 4 }}
    {{- end }}
  securityContext:
    {{- include "slax.containerSecurityContext" 10001 | nindent 4 }}
  resources:
    {{- toYaml .resources | nindent 4 }}
  volumeMounts:
    - name: storage
      mountPath: /var/www/html/storage
    - name: tmp
      mountPath: /tmp
{{- end -}}

{{- define "slax.phpVolumes" -}}
- name: storage
  emptyDir:
    sizeLimit: 256Mi
- name: tmp
  emptyDir:
    sizeLimit: 256Mi
{{- end -}}

{{- define "slax.configChecksum" -}}
checksum/config: {{ include "slax.config" . | sha256sum }}
{{- end -}}
