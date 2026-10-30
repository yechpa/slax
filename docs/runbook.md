# Slax production runbook

How production (`https://slax.yechpa.com`, the public showcase) is built, set up, operated,
repaired and torn down. Development has its own guide: [deploy/dev/BOOTSTRAP.md](../deploy/dev/BOOTSTRAP.md).

Steps marked **YOU DO THIS** need a human with the owner's accounts (AWS, DNS, Tailscale,
Google, GitHub). Nothing in this repository holds a secret, an account id or an address.

Contents: [1. Architecture](#1-architecture) · [2. Sizing and cost](#2-sizing-and-cost) ·
[3. First-time production setup](#3-first-time-production-setup) ·
[4. Routine operations](#4-routine-operations) · [5. Incident playbook](#5-incident-playbook) ·
[6. Teardown](#6-teardown) · [7. Verification checklist](#7-verification-checklist)

## 1. Architecture

```
                 Internet (TCP 80/443 only: security group slax-prod)
                                   │
            Elastic IP ── A slax.yechpa.com
                                   │
 ┌──────────────────────── EC2 t4g.small "slax-prod" (Ubuntu 24.04 arm64, eu-central-1) ─┐
 │                                 ▼                                                       │
 │  Caddy (systemd)  TLS (Let's Encrypt HTTP-01/TLS-ALPN), HSTS, X-Forwarded-For := peer, │
 │                   /apps → 404, HTTP/1.1 + HTTP/2                                        │
 │                                 │ http://10.43.0.80:80 (Service slax-app, fixed IP)    │
 │  k3s v1.36 (no Traefik, no ServiceLB)                namespace slax, PSS restricted    │
 │   ┌─ pod slax-app ───────────────────┐   ┌ slax-reverb (WebSocket /app) ┐              │
 │   │ nginx (slax-web): SPA, CSP,      │──▶│ Pusher protocol, Redis        │              │
 │   │  realip from 10.42.0.0/16        │   └───────────────────────────────┘              │
 │   │ PHP-FPM (slax-app) on 127.0.0.1  │──▶ slax-scanner (no egress)                      │
 │   └──────────────────────────────────┘                                                  │
 │   slax-queue, slax-scheduler ── slax-postgres (PVC, local-path) ── slax-redis (PVC)     │
 │   CronJobs: slax-backup 02:30 daily, slax-restore-check Sun 03:30 (Asia/Jerusalem)      │
 │   slax-monitor every minute: health, Reverb, PostgreSQL, Redis, disks → Telegram        │
 │  Tailscale (tag:slax-prod): Tailscale SSH for you, :6443 for CI (tag:ci). No sshd.      │
 └───────────────┬─────────────────────────────────────────────────────────────────────────┘
                 │ instance role slax-prod-instance (IMDSv2, hop limit 2), no static keys
                 ▼
   S3 slax-files-<suffix>   (uploads; browsers download from presigned URLs on
                             https://slax-files-<suffix>.s3.eu-central-1.amazonaws.com)
   S3 slax-backups-<suffix> (pg/YYYY/MM/DD/slax-<UTC>.dump, versioned, 35 days)
```

What runs where, and why:

| Concern | Decision |
|---|---|
| Region | **eu-central-1 (Frankfurt)**: the owner's other EC2 instance is already there, t4g and every service used are available, it is not an opt-in region, and prices are among Europe's lowest. il-central-1 (Tel Aviv) would cut latency from Israel (≈50 ms → ≈5 ms) but is an opt-in region, generally pricier, and latency does not matter for a chat demo. |
| Front door | **Caddy on the host.** It terminates TLS (automatic Let's Encrypt), sets HSTS (`max-age=31536000; includeSubDomains`, no `preload`), replaces any client `X-Forwarded-For`/`X-Real-IP` with the real peer address, and proxies to the web pod's Service on a fixed ClusterIP. k3s runs without Traefik and ServiceLB: nothing in the cluster listens on a public port, and ServiceLB's source-address rewriting does not exist. nginx in the web pod believes `X-Forwarded-For` only from the pod network, and the web pod's network policy admits no pod (only its node). Laravel trusts no proxy itself. Proven by `make proxy-test`. |
| Files | **Presigned S3 URLs, straight from the bucket** (`https://<bucket>.s3.eu-central-1.amazonaws.com`): a cross-site origin of the bucket's own, so an uploaded file can never run with the app's cookies or origin. The presigned request forces the stored type (`response-content-type`, from the scanner's allowlist: PNG/JPEG/GIF/WebP/PDF/text/zip) and the disposition (`attachment` for everything but images and PDFs). `nosniff` cannot be added to S3 responses; forcing the type covers it (browsers never sniff an `image/*` into HTML). No `files.slax.yechpa.com` record, no CloudFront, no CORS (uploads go through the app; `<img>` needs no CORS). The CSP's `img-src` names exactly that host. |
| AWS credentials | **The EC2 instance role**, through IMDSv2 with hop limit 2 so pods can reach it. The chart references no AWS key at all in production (`s3.useInstanceRole`). Only app, queue, scheduler and the backup jobs may reach the metadata service (Reverb, PostgreSQL, Redis and the migration Job are denied it; the scanner has no egress). The role can touch only the two buckets, and cannot delete backups. Flysystem sends `x-amz-acl: private` with every upload, so the role has `s3:PutObjectAcl` on the files objects; the ACL itself is inert (with *bucket owner enforced*, S3 accepts only ACLs equivalent to `bucket-owner-full-control`; `private` written by the bucket's own account grants exactly the owner full control, and is how Laravel apps write to such buckets; Block Public Access on top). Confirmed on real S3 only by checklist item 7, so the backend config is left as is. |
| Host firewall | Besides the security group (TCP 80/443 only), `slax-edge-guard` drops TCP 22/6443/10250/10256 and UDP 8472 arriving on the public interface (k3s requires it), and 9345 (the RKE2 supervisor port, unused by k3s: closed as defence in depth); 80/443, `tailscale0` and the pod network are untouched. |
| TLS for the cluster API | k3s's own certificate, `tls-san` = the Tailscale address and names. Port 6443 is closed to the Internet; CI and you reach it over the tailnet. |
| Backups | `pg_dump -Fc` daily to S3 (SSE-S3), weekly full restore into a throwaway PostgreSQL inside the check's pod (never the production server). Telegram: failures, and the weekly "restore check OK". |
| Monitoring | Outside the app: the CronJob `slax-monitor` (`deploy/monitoring/uptime.sh`) checks every minute the web pod's health, Reverb, PostgreSQL, Redis and the public URL through Caddy, and the disks; Telegram `[Prod] DOWN` after 3 failures in a row, `RECOVERED` once, `DISK` above 80 % (§4.10). Inside the app: errors and warnings go to Telegram through Laravel's log, and Administration → Status shows the database, Redis, Reverb, the scanner and S3. No metrics stack (Prometheus, Grafana): not worth its memory on 2 GiB. |
| Releases | A `vX.Y.Z` tag on a commit of `main` → check → approval in GitHub → `helm upgrade --atomic` with the `<sha>` images already tested on dev → public checks → explicit `helm rollback` if they fail. |

## 2. Sizing and cost

### Memory on t4g.small (2 vCPU, 2 GiB): measured, and the decision

**Decision: production starts on t4g.small.** The brief's acceptance test (50 WebSocket
clients, 10 messages/s for 2 minutes, instance memory under 80 %) projects to
**≈ 1.25-1.3 GiB, 62-64 % of the instance**, with no message lost. t4g.medium would add $14/month
(+67 %) for headroom this showcase does not need; move to it on the signals below.

How the number is built (the full report: [docs/load-test-results.md](load-test-results.md),
`make load`):

| Part | MiB | Source |
|---|---:|---|
| k3s itself: server, containerd and shims, CoreDNS, metrics-server, local-path | ≈ 655 | **measured**: a k3s v1.36.5 node (in Docker, amd64) running the production chart and images, idle: node working set 856 MiB minus the Slax pods' 202 MiB |
| Slax pods under the load (app with nginx and PHP-FPM, Reverb, queue, scanner, PostgreSQL, Redis; the scheduler added at the queue worker's size) | ≈ 258 | **measured** on the Compose e2e stack at the load's peak: 221 MiB without MinIO, + 37 (at rest the same pods take 202 MiB on k3s and 210 on Compose: the two agree) |
| A budget for growth | 100 | PHP-FPM may run up to 6 workers (one or two were enough at 10 requests/s), PostgreSQL's 96 MB of shared buffers fill up over days |
| Ubuntu (systemd, journald, snapd, SSM agent), Tailscale, Caddy | ≈ 250-300 | estimate (not measurable without the instance) |
| **Total at the brief's load** | **≈ 1,263-1,313** | 655 + 258 + 100 + 250-300; **62-64 % of 2,048 MiB** (the brief's limit: 80 % = 1,638 MiB) |
| Pessimistic band | **≈ 1,413-1,563** | the same, plus 150-250 MiB more if the 100 MiB budget is too small: PostgreSQL's `shared_buffers` (96 MB) filled where 31 MiB were measured, and PHP-FPM at its 6 workers where 53 MiB were measured for the whole pod; **69-76 %, still under 80 %** |

What remains (≈ 630-680 MiB of the ≈ 1,946 MiB usable at the estimate, ≈ 380-530 MiB in
the pessimistic band) is page cache and room for the CronJobs: the backup (≤ 256 MiB, 02:30),
the weekly restore check and the uptime monitor (≤ 64 MiB for a few seconds each minute).
The restore check is the big one (≤ 640 MiB with its throwaway PostgreSQL); what keeps it
from stacking on peak load is its time, Sunday 03:30 Asia/Jerusalem, when the demo is idle
(and just after the 03:00 reset): do not move it into the day. The 2 GiB swap file absorbs a
coincidence; pods do not swap.

Limits of this estimate, to keep in mind: the load ran on Compose (development PHP image,
x86) and k3s ran without load; arm64 (Graviton) processes should be of a similar size but were not
measured; the OS share is an estimate; the load generator was on the same machine. The k3s
figures are the solid part, and they agree with the ≈ 600 MiB the plan assumed.

**Move to t4g.medium (4 GiB, +$14/month)** if production shows any of: `free -m` available
below 200 MiB for long, swap in steady use (`vmstat 5` si/so non-zero), OOM kills
(`journalctl -k | grep -i oom`), pods evicted, or the uptime monitor's `DOWN` alerts while
the node is busy. How: §4.9. Checklist item 14 (§7) looks at it after a day.

### Monthly cost (eu-central-1, on-demand list prices, October 2026, before tax)

| Item | **t4g.small (chosen)** | t4g.medium (if needed) |
|---|---|---|
| EC2 instance (730 h) | $14.02 | $28.03 |
| EBS gp3 30 GB (encrypted) | $2.86 | $2.86 |
| Public IPv4 (Elastic IP, associated) | $3.65 | $3.65 |
| S3 (≈ 5 GB of files and backups + requests) | ≈ $0.40 | ≈ $0.40 |
| Data transfer out (first 100 GB/month free) | $0 | $0 |
| **Total** | **≈ $20.9** | **≈ $34.9** |

Production starts on t4g.small (the measured sizing above); the uptime monitor and the
Telegram alerts add nothing to the bill. Against the 15-20 $/month target: t4g.small lands
just above it. Levers: `SLAX_ROOT_GB=20`
(−$0.95; 20 GB is enough for the OS, images, a 10 GiB database volume and swap); a 1-year
Savings Plan or reserved instance (≈ −35 % on the instance). **With or without the Elastic
IP:** since February 2024 AWS bills every public IPv4 address, so an instance's automatic
public address costs the same $3.65 as an associated Elastic IP; the EIP adds nothing to the
bill and keeps the address (and the DNS record) stable across stop/start. Only an
IPv6-only site would save it, and too many visitors still lack IPv6. An Elastic IP that is
*not* associated also costs $3.65: release it if the instance goes away (§6). The ≈ $100 of
AWS credits cover about 5 months at t4g.small. `provision.sh` prints the same estimate
before asking for confirmation.

## 3. First-time production setup

Do the steps in this order. Each one says what proves it worked.

### 3.1 Prerequisites

**YOU DO THIS**

- An AWS account with the AWS CLI **v2** logged in (`aws sso login` with IAM Identity Center,
  or an IAM user with MFA) with enough rights to create EC2, IAM and S3 resources. Check:
  `aws sts get-caller-identity` and `aws --version` (`aws-cli/2.…`).
- The region: `export AWS_REGION=eu-central-1`. provision.sh refuses any other unless
  `--allow-region-override` (then set `s3.region` in values-prod.yaml first: the CSP names
  the bucket's regional host).
- The account has its default VPC in that region (`aws ec2 describe-vpcs --filters Name=is-default,Values=true`).
  The script never creates networks.
- `tailscale` on your machine, logged in to your tailnet; `kubectl`, `helm` 3.22.1, `gh`.

### 3.2 Tailscale: tag, policy, auth key

**YOU DO THIS**

1. Tailnet policy (admin console → Access controls), merged with your rules and the dev ones
   (deploy/dev/BOOTSTRAP.md §3):

   ```jsonc
   {
     "tagOwners": {
       "tag:slax-prod": ["autogroup:admin"],
       "tag:ci":        ["autogroup:admin"],
     },
     "acls": [
       // You: everything on the production node.
       {"action": "accept", "src": ["autogroup:admin"], "dst": ["tag:slax-prod:*"]},
       // GitHub Actions: the Kubernetes API only (the public site is checked over the Internet).
       {"action": "accept", "src": ["tag:ci"], "dst": ["tag:slax-prod:6443"]},
     ],
     "ssh": [
       // Tailscale SSH: you, as the node's "ubuntu" user (passwordless sudo), re-authenticated every 12 h.
       {"action": "check", "src": ["autogroup:admin"], "dst": ["tag:slax-prod"], "users": ["ubuntu"], "checkPeriod": "12h"},
     ],
     "tests": [
       {"src": "tag:ci", "accept": ["tag:slax-prod:6443"], "deny": ["tag:slax-prod:22", "tag:slax-prod:443", "tag:slax-prod:80"]},
     ],
   }
   ```

   (`grants` syntax for the CI rule: `{"src": ["tag:ci"], "dst": ["tag:slax-prod"], "ip": ["tcp:6443"]}`.)

2. The node's auth key. It ends up in the instance's user data, which stays readable for the
   instance's whole life: through the EC2 API (`ec2:DescribeInstanceAttribute`), through the
   instance metadata service (the node and the pods allowed to reach it) and in cloud-init's
   root-only copy on the disk. So it must be worthless once used: **single use** (not reusable), **pre-approved**, **tagged
   `tag:slax-prod`**, **not ephemeral** (an ephemeral node is removed from the tailnet after
   going offline; a server must survive reboots), and as short-lived as possible. The admin
   console's shortest expiry is one day; single use already makes it dead after the node
   joins. For a one-hour key use the API (an API access token from Settings → Keys, typed
   at a hidden prompt):

   ```sh
   read -r -s -p 'Tailscale API token: ' TS_API_TOKEN; echo
   # The token reaches curl in a config on stdin, never on its command line.
   TS_AUTHKEY="$(printf 'user = "%s:"\n' "$TS_API_TOKEN" | curl -fsS --config - \
     -H 'Content-Type: application/json' https://api.tailscale.com/api/v2/tailnet/-/keys \
     -d '{"capabilities":{"devices":{"create":{"reusable":false,"ephemeral":false,"preauthorized":true,"tags":["tag:slax-prod"]}}},"expirySeconds":3600,"description":"slax-prod bootstrap"}' \
     | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
   unset TS_API_TOKEN; export TS_AUTHKEY
   ```

   Use it within the hour (3.3). Tagged nodes have key expiry disabled by default.

### 3.3 Provision AWS

**YOU DO THIS**, from a clone of the repository:

```sh
deploy/aws/provision.sh --dry-run        # read-only: the plan and "This will cost about $X/month"
deploy/aws/provision.sh                  # same plan, then type: create slax-prod
```

It creates only resources tagged `Project=slax` and named `slax-*`, re-applies their settings
when run again, and stops if a `slax-*` name is held by something without that tag (see the
script's header). It never touches the `wa-bot` instance or anything else. Bucket names
get a suffix derived from the account id (stable; or set `SLAX_BUCKET_SUFFIX`).

It ends with what to do next: the DNS record, the redirect URIs, the two GitHub variables
(`SLAX_FILES_BUCKET`, `SLAX_BACKUPS_BUCKET`). Keep that output. Running it again prints the
same (creating nothing). Then: `unset TS_AUTHKEY`.

### 3.4 DNS

**YOU DO THIS** at your DNS provider:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `slax.yechpa.com` | the Elastic IP printed by provision.sh | 300 |

No `files.slax.yechpa.com` record: browsers fetch files from the bucket's own S3 host. No
AAAA record (the instance has no IPv6). If the zone has a CAA record, it must allow
`letsencrypt.org`. Check: `dig +short slax.yechpa.com` → the Elastic IP.

### 3.5 The node boots

Cloud-init installs everything in 5-10 minutes. **YOU DO THIS**:

```sh
tailscale ssh ubuntu@slax-prod -- cloud-init status --wait          # status: done
tailscale ssh ubuntu@slax-prod -- sudo tail -n 30 /var/log/slax-bootstrap.log
tailscale ssh ubuntu@slax-prod -- sudo k3s kubectl get nodes        # slax-prod Ready
tailscale ssh ubuntu@slax-prod -- systemctl is-active caddy k3s     # active active
```

In the Tailscale admin console the machine `slax-prod` shows tag `tag:slax-prod`, and the
auth key shows as used. Caddy gets its certificate as soon as DNS points at the node (until
then it retries; `journalctl -u caddy`).

### 3.6 Namespace, deployer, kubeconfig for CI

**YOU DO THIS** (from your machine; the files go through Tailscale SSH's stdin):

```sh
tailscale ssh ubuntu@slax-prod -- sudo k3s kubectl apply -f - < deploy/dev/deployer-rbac.yaml
```

Same file as dev: namespace `slax` (Pod Security *restricted* enforced) and the
namespace-scoped `slax-deployer` (Deployments, StatefulSets, Jobs, CronJobs, Services,
ConfigMaps, Secrets, NetworkPolicies in `slax` only). Then build its kubeconfig on the node
exactly as deploy/dev/BOOTSTRAP.md §7, with two changes: `NODE` is the node's MagicDNS name
(`tailscale status | grep slax-prod`, e.g. `slax-prod.<tailnet>.ts.net`, listed in `tls-san`)
and the cluster/context names are `slax-prod`. Keep `/tmp/slax-deployer.kubeconfig.b64`
for 3.10, then shred it.

For your own `kubectl` from your machine: copy `/etc/rancher/k3s/k3s.yaml` from the node
(root only), replace `127.0.0.1` by the MagicDNS name, keep it `chmod 600`. Or simply run
`sudo k3s kubectl` on the node through Tailscale SSH.

### 3.7 Google sign-in

**YOU DO THIS** in Google Cloud Console (APIs & Services):

- OAuth consent screen: user type *External*, app name *Slax*, your support e-mail,
  authorized domain `yechpa.com`, scopes `openid`, `email`, `profile` only (no verification
  needed for these), publishing status *In production* (in *Testing* only listed test users
  can sign in).
- Credentials → the OAuth client of type *Web application* (dev's, or a new one for prod).
  **Authorized redirect URIs** (exactly; the route is `GET /auth/google/callback`):
  - `https://dev.slax.yechpa.com/auth/google/callback`
  - `https://slax.yechpa.com/auth/google/callback`

  No JavaScript origin is needed (the exchange happens on the server).
- Cloudflare Turnstile: add `slax.yechpa.com` to the widget's hostnames.

### 3.8 Application secrets

**YOU DO THIS**. The same script as dev, run on the node, with **no S3 keys** (the instance
role replaces them):

```sh
tailscale ssh ubuntu@slax-prod -- 'cat > /tmp/create-secrets.sh' < deploy/dev/create-secrets.sh
tailscale ssh -t ubuntu@slax-prod -- sudo S3_KEYS=none bash /tmp/create-secrets.sh
tailscale ssh ubuntu@slax-prod -- rm /tmp/create-secrets.sh
```

Hidden prompts: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET`, then optional `ADMIN_EMAILS` (administrators: personal data, so here and
never in values), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (the same bot and chat as dev:
production messages start with `[Prod]`). Generated: `APP_KEY`, `DB_PASSWORD`,
`REDIS_PASSWORD`, `REVERB_APP_KEY`, `REVERB_APP_SECRET` and the Web Push pair
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (`PUSH_KEYS=none` to leave push off; see 4.11). Check:
`sudo k3s kubectl -n slax get secret slax-secrets -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2`
lists the key names (no `AWS_*`).

### 3.9 Images public

**YOU DO THIS** after the first `Images` run on `main` that includes `slax-backup`: make that
package **public** like the other three (github.com/yechpa?tab=packages → `slax-backup` →
Package settings → Change visibility → Public; deploy/dev/BOOTSTRAP.md §9.3). A new GHCR
package is private, and k3s pulls without credentials: dev runs it too (the uptime monitor,
`slax-monitor`, every minute), so a private package shows there first as `ImagePullBackOff`. The release workflow's `check` job probes
all four images anonymously and refuses to deploy while one is private. Check, logged out:
`docker buildx imagetools inspect ghcr.io/yechpa/slax-backup:<sha>`.

### 3.10 GitHub: environment `production`

**YOU DO THIS** (Settings → Environments → New environment `production`):

1. **Required reviewers**: yourself (and anyone else allowed to release). Leave "Prevent
   self-review" off if you are the only maintainer, or no one can approve.
2. **Deployment branches and tags**: *Selected* → add the tag pattern `v*`.
3. Secrets (`gh` prompts without echo):

   ```sh
   gh secret set TS_OAUTH_CLIENT_ID --env production --repo yechpa/slax   # the tag:ci OAuth client (dev's works)
   gh secret set TS_OAUTH_SECRET    --env production --repo yechpa/slax
   gh secret set TELEGRAM_BOT_TOKEN --env production --repo yechpa/slax
   gh secret set TELEGRAM_CHAT_ID   --env production --repo yechpa/slax
   gh secret set PROD_KUBECONFIG    --env production --repo yechpa/slax < /tmp/slax-deployer.kubeconfig.b64
   shred -u /tmp/slax-deployer.kubeconfig /tmp/slax-deployer.kubeconfig.b64   # wherever they are
   ```

4. Variables (not secret; from provision.sh's output):

   ```sh
   gh variable set SLAX_FILES_BUCKET   --env production --repo yechpa/slax --body slax-files-<suffix>
   gh variable set SLAX_BACKUPS_BUCKET --env production --repo yechpa/slax --body slax-backups-<suffix>
   ```

5. Protect the release tags: Settings → Rules → Rulesets → New *tag* ruleset, target
   `v*`, restrict creations, updates and deletions to administrators (bypass list: you).
   The workflow refuses a tag that is not on `main` anyway.

### 3.11 First release: v0.1.0

1. Pick a commit of `main` whose `Images` run is green (every job: `published`, then 8 `build`,
   8 `push` and 4 `manifest` jobs for 4 images on 2 architectures; those are skipped when an
   earlier run already published that commit) and that dev runs well.
2. Tag and push it:

   ```sh
   git fetch origin && git tag -a v0.1.0 -m "Slax 0.1.0" origin/main && git push origin v0.1.0
   ```

3. Actions → *Release prod*: `check` passes (tag on main, images exist), then `deploy`
   waits: **Review deployments → Approve**.
4. The first install creates the release; the migration Job runs after it and seeds the demo
   content. Watch: `sudo k3s kubectl -n slax get pods -w` on the node.
5. Telegram: `[Prod] Release v0.1.0 (…) is live on slax.yechpa.com.` Then run the
   verification checklist (§7).

## 4. Routine operations

Commands below run on the node (`tailscale ssh ubuntu@slax-prod`), as `sudo k3s kubectl …`,
abbreviated `kubectl`; `helm` likewise with `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`, or from
your machine with your kubeconfig over the tailnet.

### 4.1 Deploy a release

Merge to `main`, let dev deploy and look right, then tag `vX.Y.Z` on that commit and push
the tag (3.11). Approve in Actions. Production always runs the immutable `<sha>` images that
dev ran; `vX.Y.Z` is only an alias. A by-hand deploy (same as CI):

```sh
helm upgrade --install slax deploy/helm/slax --namespace slax \
  -f deploy/helm/slax/values-prod.yaml --set image.tag=<full sha> \
  --set s3.bucket=slax-files-<suffix> --set backup.bucket=slax-backups-<suffix> \
  --atomic --wait --timeout 15m
```

### 4.2 Roll back

```sh
helm -n slax history slax                     # REVISION, app version (the sha), status
helm -n slax rollback slax <REVISION> --wait --timeout 10m
```

`helm rollback slax` with no revision goes to the previous one. A failed `--atomic` upgrade
has already rolled itself back; the release workflow rolls back by itself when the public
checks fail after a successful upgrade. Migrations are not undone (expand then contract:
older code runs on the newer schema).

### 4.3 Backups

- Where: `s3://slax-backups-<suffix>/pg/YYYY/MM/DD/slax-<UTC>.dump`, daily at 02:30
  Asia/Jerusalem, kept 35 days (+7 days as a non-current version). Telegram says nothing on a
  successful backup; it says `[Prod] Backup FAILED at step "…"` on a failure, and every Sunday
  `[Prod] Weekly restore check OK: …` (or `FAILED`). **No Sunday message = investigate.**
  A SIGTERM (deadline, eviction) says `TERMINATED at step …`.
- Independently, the app checks the bucket every morning at 09:00 Asia/Jerusalem
  (`backups:check-freshness`, the scheduler pod): a newest dump older than 30 hours, none at
  all, or a listing error raise a critical `[Prod]` alert ("Database backup is stale",
  "No database backup found", "Database backups cannot be listed"). By hand:
  `kubectl -n slax exec deploy/slax-scheduler -- php artisan backups:check-freshness`.
- Run one now: `kubectl -n slax create job --from=cronjob/slax-backup slax-backup-manual-$(date +%s)`;
  a restore check now: `kubectl -n slax create job --from=cronjob/slax-restore-check slax-restore-check-manual-$(date +%s)`;
  logs: `kubectl -n slax logs -l app.kubernetes.io/component=backup --tail=50` (or `restore-check`).
- List them (your AWS CLI): `aws s3 ls s3://slax-backups-<suffix>/pg/ --recursive | tail`.
- The instance role cannot delete backups; only the lifecycle rule (and you) can.

### 4.4 Restore the production database from a backup

Data written since that backup is lost: say so on the site first if anyone uses it.

1. Make sure the dump restores: run a restore check now (4.3) on the chosen dump (it takes the
   newest; for an older one, restore it on your machine into a scratch PostgreSQL 16 first).
2. Stop everything that writes. The uptime monitor would report the app and Reverb DOWN after
   three minutes: pause it too (§4.10, "Pause it"):

   ```sh
   kubectl -n slax patch cronjob slax-monitor -p '{"spec":{"suspend":true}}'
   kubectl -n slax scale deployment slax-app slax-queue slax-scheduler slax-reverb --replicas=0
   kubectl -n slax patch cronjob slax-backup -p '{"spec":{"suspend":true}}'
   ```

3. Restore with a one-off pod of the backup image (it may reach PostgreSQL: it carries the
   backup's label). `KEY` is the dump's key, `TAG` the deployed sha (`helm -n slax history slax`):

   ```sh
   KEY=pg/2026/10/30/slax-20261030T003000Z.dump TAG=<sha> BUCKET=slax-backups-<suffix>
   cat <<EOF | kubectl -n slax apply -f -
   apiVersion: batch/v1
   kind: Job
   metadata: {name: slax-restore-manual}
   spec:
     backoffLimit: 0
     template:
       metadata:
         labels: {app.kubernetes.io/name: slax, app.kubernetes.io/instance: slax, app.kubernetes.io/component: backup}
       spec:
         restartPolicy: Never
         automountServiceAccountToken: false
         securityContext: {runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, seccompProfile: {type: RuntimeDefault}}
         containers:
           - name: restore
             image: ghcr.io/yechpa/slax-backup:${TAG}
             command: [bash, -c, 'set -euo pipefail; aws s3 cp --only-show-errors "s3://\$BUCKET/\$KEY" /tmp/r.dump; pg_restore --list /tmp/r.dump >/dev/null; pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction -d slax /tmp/r.dump; echo restored']
             env:
               - {name: BUCKET, value: "${BUCKET}"}
               - {name: KEY, value: "${KEY}"}
               - {name: AWS_REGION, value: eu-central-1}
               - {name: HOME, value: /tmp}
               - {name: PGHOST, value: slax-postgres}
               - {name: PGUSER, value: slax}
               - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: slax-secrets, key: DB_PASSWORD}}}
             securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
             resources: {requests: {memory: 64Mi}, limits: {memory: 256Mi}}
             volumeMounts: [{name: tmp, mountPath: /tmp}]
         volumes: [{name: tmp, emptyDir: {sizeLimit: 2Gi}}]
   EOF
   kubectl -n slax wait --for=condition=complete job/slax-restore-manual --timeout=15m
   kubectl -n slax logs job/slax-restore-manual          # ... restored
   kubectl -n slax delete job slax-restore-manual
   ```

4. Start again: `kubectl -n slax scale deployment slax-app slax-queue slax-scheduler slax-reverb --replicas=1`,
   `kubectl -n slax patch cronjob slax-backup -p '{"spec":{"suspend":false}}'`, the monitor
   once the app answers again (`kubectl -n slax patch cronjob slax-monitor -p '{"spec":{"suspend":false}}'`),
   then the checklist items 2-4 of §7.
5. Check that nothing stayed paused: `kubectl -n slax get cronjob slax-monitor slax-backup`
   shows `SUSPEND` `False` for both.

### 4.5 Rotate secrets

- One application key: `sudo bash /tmp/create-secrets.sh set KEY` (copy the script over as in
  3.8), then `kubectl -n slax rollout restart deployment`. Not `DB_PASSWORD`/`REDIS_PASSWORD`
  this way (the servers keep their initial password: `ALTER ROLE` first). Rotating `APP_KEY`
  signs everyone out.
- Google client secret: add a new secret in Google Cloud, `set GOOGLE_CLIENT_SECRET`, restart,
  then delete the old one in Google Cloud.
- The CI deployer token: `kubectl -n slax delete secret slax-deployer-token`, re-apply
  `deployer-rbac.yaml` (3.6), rebuild the kubeconfig, `gh secret set PROD_KUBECONFIG …`.
- Tailscale OAuth client (CI): generate a new one, update `TS_OAUTH_*` in both environments,
  revoke the old one. The node's own key never expires (tagged node).
- Telegram bot token: BotFather `/revoke`, then `set TELEGRAM_BOT_TOKEN` (prod and dev) and
  the GitHub secrets of both environments.
- AWS: there is no static key to rotate; the instance role's credentials rotate by themselves.
- Web Push (VAPID) pair: `sudo bash /tmp/create-secrets.sh vapid`, then restart. Every device
  must turn notifications on again (4.11).

### 4.6 Ban, unban, moderate

In the app, as an administrator (`ADMIN_EMAILS`): Administration → a person → Ban; the
"Banned" list lifts a ban. Every action lands in the audit log (Administration → Audit), with
the visitor's real address. An administrator listed in `ADMIN_EMAILS` cannot be banned.

**Family accounts (members).** Everyone who signs up with Google is a `demo` account, like any
visitor of the public demo: in production the nightly reset (4.7) deletes what they write, and
the account after 7 days without activity. To keep a relative's messages: Administration →
Accounts (most recently seen first; ask them to sign in once, then look at the top) → **Make
member** → confirm. It is audited (`user.made_member`) and sent to Telegram; **Make demo
account** undoes it (`user.made_demo`, a warning: their content goes at the next reset). An
administrator (`ADMIN_EMAILS`) is always a member and has no button. Promote during the day,
not around 03:00: the reset decides who is a demo account when it starts, so a promotion while
it runs counts only the next night. No e-mail address is configured anywhere for this
(decision: the click, not an allowlist in env). Do it the same day they sign up: whatever they
wrote before the promotion and the next 03:00 reset is deleted with the demo content. In
production the public channels are the demo's, readable by every visitor: create a **private**
channel for the family (New channel → private) and add each member to it. The family guide for
them: [family-guide.md](family-guide.md).

### 4.7 Demo reset

Every night at 03:00 Asia/Jerusalem the scheduler resets the demo (`SLAX_DEMO_RESET_ENABLED=true`
in production only): visitors' accounts and content go, the seed comes back; banned accounts
are kept. By hand: `kubectl -n slax exec deploy/slax-scheduler -- php artisan slax:demo-reset`.

Members (4.6) and administrators are kept with their content, **except** where it belongs to
demo content (Ruling P, tested in `DemoResetTest`): a conversation or group conversation with
a demo account in it is deleted whole, the members' messages included; so is a channel a demo
account created, and a thread a demo account started (the members' replies go with it). The
demo's sample messages get exactly their sample reactions back, so a member's reaction on one
of them goes too. A conversation between members only, their own channels, threads and
reactions on members' messages stay. Tell the family to talk in their own channels and
conversations, not with the demo's visitors.

### 4.8 Logs and state

| What | Command |
|---|---|
| Pods | `kubectl -n slax get pods -o wide`; `kubectl -n slax top pods` |
| App, API errors | `kubectl -n slax logs deploy/slax-app -c php --tail=100`; nginx: `-c web` |
| Queue, scheduler, Reverb | `kubectl -n slax logs deploy/slax-queue` (likewise `slax-scheduler`, `slax-reverb`) |
| Migrations of the last deploy | `kubectl -n slax logs job/slax-migrate` |
| Backups | `kubectl -n slax get cronjobs,jobs`; logs as in 4.3 |
| Caddy (TLS, proxy errors) | `journalctl -u caddy --since -1h` (no access log by design) |
| k3s, the node | `journalctl -u k3s --since -1h`; `free -m`; `df -h /`; `vmstat 5` |
| First boot | `/var/log/slax-bootstrap.log`, `cloud-init status --long` |

**Sessions** (Redis, `SESSION_DRIVER=redis-tiered`). A signed-in session lasts
`SESSION_LIFETIME`, the chart's `session.lifetimeMinutes` (default 20160 = 14 days), rolling:
every request starts the count again, so a tapped notification after a quiet week opens the
conversation, not Google sign-in. A session nobody is signed in to (the app's first call from a
visitor, a crawler, the CSRF cookie, a sign-in on its way to Google, the fresh session after a
sign-out) is kept **2 hours at most** (`session.guest_lifetime`), so anonymous traffic cannot
pile up for two weeks. Sign-out and a ban end a session at once whatever the lifetime (the id
is tombstoned in Redis, so a late request cannot bring it back). To change the lifetime:
`--set session.lifetimeMinutes=<minutes>` (a whole number, at least 1; `config.extraEnv`
cannot set it); the pods restart on the config checksum.

**Redis memory.** One Redis holds, in database 0, the sessions (keys
`slax-database-slax-cache-<40 characters>`), presence, the session index and tombstones,
and the **queue** (`slax-database-queues:*`); database 1 holds the cache and the rate limits.
`maxmemory` is 96 MB in production with `--maxmemory-policy volatile-lru`: when full, Redis
evicts the least recently used keys **that have an expiry** (all of the above but the queue)
instead of refusing writes, so the app keeps working; the price is that some people are signed
out (their session evicted) and presence or a rate-limit window may restart. A guest session is
about 420 bytes: 96 MB holds roughly 200 000 of them, a sustained 30 new visitors a second for 2
hours. Check:

```sh
kubectl -n slax exec statefulset/slax-redis -- redis-cli info memory | grep -E '^(used_memory_human|maxmemory_human|maxmemory_policy)'
kubectl -n slax exec statefulset/slax-redis -- redis-cli info stats | grep -E '^(evicted_keys|rejected_connections)'
kubectl -n slax exec statefulset/slax-redis -- redis-cli info keyspace
kubectl -n slax exec statefulset/slax-redis -- redis-cli -n 0 llen slax-database-queues:default
```

What to expect and do:

- **`evicted_keys` grows, the app works.** A burst of visitors or a crawler: their sessions
  expire within 2 hours of the burst ending, and memory comes back by itself. Nothing to do,
  unless signed-in people complain of being signed out: then find the source (Caddy has no
  access log by design; `kubectl -n slax logs deploy/slax-app -c web` shows nginx's) and block
  it upstream.
- **Requests fail with 500 and the logs say `OOM command not allowed`.** Nothing evictable is
  left: the queue itself has grown (a stopped or failing queue worker, `llen` above in the
  thousands). Fix the worker first (`kubectl -n slax logs deploy/slax-queue`, `rollout restart
  deployment/slax-queue`); the backlog drains.
- **Free the sessions at once** (everyone is signed out and signs in again with Google; the
  family keeps their notifications): delete the session keys of database 0, never the whole
  database (it holds the queue):

  ```sh
  kubectl -n slax exec statefulset/slax-redis -- sh -c \
    "redis-cli -n 0 --scan --pattern 'slax-database-slax-cache-*' | xargs -r -n 500 redis-cli -n 0 unlink"
  ```

  `redis-cli -n 1 flushdb` empties the cache database only: harmless (rate limits and alert
  grouping start again) but it frees no session.

### 4.9 Scale

- **Bigger instance** (t4g.small → t4g.medium), ≈ 2 minutes of downtime, the Elastic IP and the
  disk stay:

  ```sh
  ID=$(aws ec2 describe-instances --filters Name=tag:Project,Values=slax Name=tag:Name,Values=slax-prod \
       --query 'Reservations[].Instances[].InstanceId' --output text); echo "$ID"   # exactly one id
  aws ec2 stop-instances --instance-ids "$ID" && aws ec2 wait instance-stopped --instance-ids "$ID"
  aws ec2 modify-instance-attribute --instance-id "$ID" --instance-type '{"Value":"t4g.medium"}'
  aws ec2 start-instances --instance-ids "$ID"
  ```

  Then `SLAX_INSTANCE_TYPE=t4g.medium` for later provision.sh runs, and raise
  `values-prod.yaml` limits if useful.
- **Bigger disk**: `aws ec2 modify-volume --volume-id <the slax-prod-root volume> --size 40`,
  then on the node `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`.
- More replicas are not useful on one node (Reverb, queue and scheduler must stay single).

### 4.10 Uptime and disk alerts

The CronJob `slax-monitor` (chart `monitor.*`, script `deploy/monitoring/uptime.sh` in the
slax-backup image) runs every minute, outside Laravel: it keeps alerting when the app, its
queue or its Redis are down. It needs no Kubernetes API access; its state (failure counts,
what was sent) is a small file on its own 16 Mi volume.

| Check | How | In the messages |
|---|---|---|
| `app` | `GET http://slax-app/api/v1/health` (nginx + PHP-FPM + Laravel booting) | `HTTP 503`, `timeout`, `connection refused`... |
| `reverb` | `GET http://slax-reverb:8080/up` | same |
| `postgres` | `pg_isready` (no password sent, so no sign-in is attempted) | `no answer`, `rejecting connections` |
| `redis` | a bare `PING` (no password: `-NOAUTH` proves it is up) | `no answer`, `timeout` |
| `public` (production) | `GET https://slax.yechpa.com/api/v1/health` from the node, through the Elastic IP, Caddy and its certificate | `TLS error`, `DNS failure`, `HTTP 502`... |
| disks | `df` on its emptyDir (the kubelet's disk) and on its volume (the local-path volumes' disk); on the production node both are the root disk, reported once as `node` | percentages |

Messages (`[Prod]` or `[Dev]`, the check's name, a status or a failure class, counts, a
UTC time; never a URL, host or secret):

- `[Prod] DOWN: app failed 3 checks in a row (HTTP 503), since 14:02 UTC.`: three failures
  in a row (≈ 3 minutes). One message, however long it lasts.
- `[Prod] RECOVERED: app is answering again (HTTP 200) after about 7 min down (7 failed checks).`
- `[Prod] DISK: node disk 83% full (alert above 80%). Reminder every 6 h while above; all clear below 75%.`
  then, once below 75 %, `[Prod] DISK OK: node disk back to 72% (below 75%).`

A message Telegram refuses (network, Telegram down) is retried the next minute; the
monitor logs a warning with curl's exit code, never the token. A run never outlives its
Job: the checks run in parallel (10 s at most), a Telegram call is given 5 s, and an alert
that could not finish within 35 s of the start is left for the next run (logged as
`deferred to the next run`); the state is saved after every alert sent, so a run cut short
never sends one twice. A run always succeeds as a
Job unless its configuration is wrong (exit 2: `kubectl -n slax get jobs` shows it failed).

- What it sees now: `kubectl -n slax logs -l app.kubernetes.io/component=monitor --tail=5`
  (`uptime: app=ok reverb=ok postgres=ok redis=ok public=ok disk:node=34% disk:volumes=same-as-node`).
- Run it at once: `kubectl -n slax create job --from=cronjob/slax-monitor slax-monitor-now`
  (between two scheduled runs: the two would share the state file), then
  `kubectl -n slax logs job/slax-monitor-now` and `kubectl -n slax delete job slax-monitor-now`.
- Test the alert path without touching production's traffic: scale Reverb down for
  four minutes (the site works; only live updates pause and clients reconnect):

  ```sh
  kubectl -n slax scale deploy slax-reverb --replicas=0
  # 3-4 minutes later: [Prod] DOWN: reverb failed 3 checks in a row (connection refused) ...
  kubectl -n slax scale deploy slax-reverb --replicas=1
  # within 2 minutes: [Prod] RECOVERED: reverb is answering again (HTTP 200) ...
  ```

  Or, on dev, the same with `slax-app`. Never stop PostgreSQL for a test.
- Pause it (maintenance, a manual restore §4.4): `kubectl -n slax patch cronjob slax-monitor -p '{"spec":{"suspend":true}}'`,
  and `false` afterwards: it stays suspended across releases until you do (Helm leaves a
  field it never set alone). `kubectl -n slax get cronjob slax-monitor` shows `SUSPEND` `False`
  once it runs again.
- Thresholds: `monitor.failThreshold` (3), `monitor.disk.alertPercent` (80),
  `recoverPercent` (75), `realertHours` (6) in the values; a release applies them.

What it cannot see: the node itself dead or cut from the Internet (nothing runs to send);
the Sunday "restore check OK" and Telegram's silence are then the signal. An external
pinger (a free uptime service polling `/api/v1/health`) would cover that; none is set up
(docs/known-limitations.md).

### 4.11 Push notifications

Web Push (VAPID) from the queue worker (queue `push`, drained after `default`: chart
`queue:work --queue=default,push`) to the browsers' push services (FCM for Chrome and
Android, Apple for Safari and iOS, Mozilla, Microsoft). **Real delivery to these services was
NOT tested here** (no automated run reaches them; see docs/known-limitations.md, "Push
notifications", for the checklist the family runs on real devices).

- **Keys.** One P-256 pair per environment, in the Secret only: `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` (both optional: without them push is off, the endpoints answer 404 and the
  app hides its switch). `create-secrets.sh` generates the pair (3.8). Another way to get one:
  `kubectl -n slax exec deploy/slax-app -c php -- php artisan slax:push-keys` prints two lines
  and writes nothing; put each value in with `create-secrets.sh set VAPID_PUBLIC_KEY` and
  `set VAPID_PRIVATE_KEY`, then restart. Never in values, `config.extraEnv` (refused) or the
  repository. `VAPID_SUBJECT` (ConfigMap) is `push.subject` (a `mailto:` or `https:` URL),
  else the public URL.
- **Check it is on.** In the app, account menu: "Notifications on this device" appears (on an
  iPhone, in the installed app only; in Safari the menu says to install first). Or
  `curl -s https://slax.yechpa.com/api/v1/push/public-key` with a session (404
  `push_disabled` means off).
- **Test.** Turn the switch on, then "Send a test": every device of your account gets
  "Notifications work on this device." within seconds. Nothing: see the queue's log
  (`kubectl -n slax logs deploy/slax-queue | grep -i push`): "refused by the push service"
  with a status (403: the keys or the subject; 400/413: the device's keys or the payload) or
  "dropped after retries" (the push service unreachable).
- **Who is notified.** DMs and group conversations, @mentions, replies in threads the person
  started or replied in; never someone shown `online` (connected and active in Slax in the
  last 5 minutes, on any device): `away` and `offline` people are. So to check real delivery,
  close the app on every device (or leave it untouched 5 minutes) before someone writes to
  you. The test button ignores presence.
- **Rotate.** `sudo bash /tmp/create-secrets.sh vapid`, then
  `kubectl -n slax rollout restart deployment`. Rotation invalidates every subscription: old
  devices are deleted at their next push, the app shows the switch off, and everyone turns
  notifications on again (tell the family first). Rotate only if the private key leaked.
- **iPhone and iPad.** iOS 16.4 or later, Slax added to the Home Screen and opened from its
  icon, then the switch, then "Allow". Notifications can be managed afterwards in iOS Settings →
  Notifications → Slax.
- **Dead subscriptions** clean themselves: a 404/410 from the push service deletes the device;
  429, 5xx or no answer are retried after 30 s, 2 min and 10 min, then dropped (a warning in
  the queue's log, no alert); a ban deletes all of the account's devices; an account keeps ten
  devices at most. To see them: `kubectl -n slax exec deploy/slax-app -c php -- php artisan
  tinker --execute 'echo App\Models\PushSubscription::count();'`. To turn push off
  everywhere at once: delete both keys from the Secret and restart (the devices stay, unused,
  until the keys come back or the accounts go).
- **Privacy.** A notification carries the sender's and the channel's names and a generic line
  ("New message", "You were mentioned", "New reply"), never the text, an e-mail address or a
  file name; it is encrypted for the browser, the push service cannot read it.

## 5. Incident playbook

### Site down (`curl -I https://slax.yechpa.com` fails or 5xx)

1. From your machine: DNS (`dig +short slax.yechpa.com` = the Elastic IP)? The instance
   running (`aws ec2 describe-instance-status --instance-ids <id>`)?
2. On the node: `systemctl is-active caddy k3s`; `journalctl -u caddy -n 50`.
   502 from Caddy = the cluster side: `kubectl -n slax get pods`; `kubectl -n slax get svc slax-app`
   (ClusterIP must be 10.43.0.80); describe the failing pod.
3. A bad release: roll back (4.2). Memory: `free -m`, `journalctl -k | grep -i oom` → §4.9.
   A failed first boot (`/var/log/slax-bootstrap.log` ends without "bootstrap done"): fix the
   cause, then `tailscale ssh ubuntu@slax-prod -- sudo bash /usr/local/sbin/slax-bootstrap.sh`
   (every step is safe to repeat). If Tailscale itself never came up, use the break-glass
   shell below and run the same command there. If `tailscale up` failed *after* reaching
   Tailscale (the log shows it, or the key is marked used in the admin console), the
   single-use key is spent: create a new one (§3.2), and in the break-glass shell run
   `sudo install -d -m 700 /run/slax-bootstrap`, write the key to
   `/run/slax-bootstrap/ts-authkey` (`sudo sh -c 'umask 077; cat > /run/slax-bootstrap/ts-authkey'`,
   paste, Ctrl-D), then
   `sudo tailscale up --auth-key=file:/run/slax-bootstrap/ts-authkey --hostname=slax-prod --advertise-tags=tag:slax-prod --ssh`
   and `sudo bash /usr/local/sbin/slax-bootstrap.sh` (it shreds the file).
4. Node unreachable on the tailnet too: AWS console → the instance → *Reboot*. Still nothing:
   *Get system log* / *Get instance screenshot*. Break-glass shell without opening a port:
   attach the managed policy `AmazonSSMManagedInstanceCore` to the role `slax-prod-instance`
   (`aws iam attach-role-policy --role-name slax-prod-instance --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`),
   wait a few minutes, `aws ssm start-session --target <id>` (the SSM agent ships with
   Ubuntu's AMI), then **detach it again** (`aws iam detach-role-policy …`): every pod could
   use it while attached.

### Database full

`kubectl -n slax exec slax-postgres-0 -- df -h /var/lib/postgresql/data` and `df -h /` on the
node (the local-path volume lives on the root disk; the 10Gi claim is not a hard limit).
Usual causes: the audit log (retention `SLAX_AUDIT_RETENTION_DAYS`), orphan files' rows, WAL
after a crash. Free space on the node first (`sudo k3s crictl rmi --prune`,
`journalctl --vacuum-size=100M`), then grow the disk (4.9). PostgreSQL refuses writes when the
disk is full; it recovers by itself once there is room.

### Telegram: `DOWN` or `DISK` from the uptime monitor

- `DOWN: public` alone (the in-cluster `app` is fine): the edge. Caddy (`systemctl status
  caddy`, `journalctl -u caddy -n 50`), the certificate (§5 "Certificate expiry"), DNS
  (`dig +short slax.yechpa.com`), the security group.
- `DOWN: app` (and `public`): the web pod. `kubectl -n slax get pods`, `describe` the app
  pod, `logs deploy/slax-app -c php` / `-c web`; a bad release: roll back (§4.2).
- `DOWN: reverb`: realtime is paused (pages still load). `kubectl -n slax logs deploy/slax-reverb`,
  `rollout restart deployment slax-reverb`.
- `DOWN: postgres` or `redis`: everything is broken. `kubectl -n slax describe pod slax-postgres-0`
  (or `slax-redis-0`), its logs, then the disk (`df -h /`).
- `DISK`: §5 "Database full" below; the usual suspects on the node are container images
  (`sudo k3s crictl rmi --prune`), the journal (`journalctl --vacuum-size=100M`) and the
  database.

### Telegram storm

Alerts are grouped and rate-limited by the app (docs/known-limitations.md). If the chat floods
anyway: find the source (`[Prod]` messages name the error), fix or roll back. To silence
production meanwhile: `sudo bash /tmp/create-secrets.sh set TELEGRAM_CHAT_ID` with an invalid
value (or remove the key: `kubectl -n slax patch secret slax-secrets --type json -p '[{"op":"remove","path":"/data/TELEGRAM_CHAT_ID"}]'`),
`kubectl -n slax rollout restart deployment`; restore it afterwards. The uptime monitor reads
the Secret at each run (every minute): it follows without a restart; to silence only it,
suspend its CronJob (§4.10).

### S3 errors (uploads or downloads fail, backups fail at "upload")

1. Probe the bucket with the pods' own credentials:
   `kubectl -n slax exec deploy/slax-queue -- php artisan slax:s3-probe` → `PASS`, or
   `FAIL at <step> (…): <AWS error code> (<class>)`. The app's disks run with `throw => false`,
   so a refused write only shows up as a failed upload (no AWS error in the logs): the probe
   forces errors on and names them. Without a running release, use the one-off pod of §7
   item 7. `CredentialsException` / timeouts to 169.254.169.254: the instance metadata options
   (`aws ec2 describe-instances … MetadataOptions`: HttpTokens required, hop limit **2**;
   provision.sh re-applies them) or the instance profile is missing.
2. `AccessDenied` (on uploads: also check `s3:PutObjectAcl` is in the files statement, Flysystem
   sends `x-amz-acl: private`): the role policy (`aws iam get-role-policy --role-name slax-prod-instance --policy-name slax-prod-s3`)
   names other buckets than the deployed `s3.bucket` / `backup.bucket`. Re-run provision.sh.
3. Downloads blocked in the browser: the CSP `img-src` must be the bucket's host
   (`curl -sI https://slax.yechpa.com | grep -i content-security-policy`).

### Certificate expiry / TLS errors

Caddy renews 30 days before expiry. It needs port 80 or 443 reachable from the Internet and
DNS pointing at the Elastic IP. `journalctl -u caddy | grep -iE 'obtain|renew|error'`. Check
the certificate: `echo | openssl s_client -connect slax.yechpa.com:443 -servername slax.yechpa.com 2>/dev/null | openssl x509 -noout -dates`.
Let's Encrypt rate limits (5 failed validations per hour) mean: fix DNS/firewall first, then
`systemctl reload caddy`.

### Backup or restore check failed

The alert names the step. `pg_dump`: is PostgreSQL up, is `DB_PASSWORD` right? `upload`:
see S3 errors. `backup age` in the restore check: the daily backup stopped (CronJob suspended?
`kubectl -n slax get cronjob slax-backup`). `pg_restore`/`users > 0`: the dump is bad: run a
backup by hand now (4.3), keep older dumps (they expire after 35 days), investigate.

## 6. Teardown

Only for retiring production. Every command targets ids found by the tag `Project=slax`
**and** a `slax-*` name; print them and read them before going on. Nothing here may touch
the `wa-bot` instance or anything without that tag.

**YOU DO THIS**. First look, read-only:

```sh
export AWS_REGION=eu-central-1
aws ec2 describe-instances --filters Name=tag:Project,Values=slax Name=tag:Name,Values=slax-prod \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==`Name`].Value|[0]]' --output text
aws ec2 describe-addresses --filters Name=tag:Project,Values=slax --query 'Addresses[].[AllocationId,PublicIp]' --output text
aws ec2 describe-security-groups --filters Name=tag:Project,Values=slax --query 'SecurityGroups[].[GroupId,GroupName]' --output text
aws s3api list-buckets --query "Buckets[?starts_with(Name, 'slax-')].Name" --output text
```

Then the teardown, in a subshell that stops at the first problem (it never closes your
terminal): it looks the ids up again by tag and name, and refuses unless each lookup gives
exactly one well-formed id. Set `SUFFIX` to the bucket suffix shown above.

```sh
SUFFIX=<the bucket suffix> bash -euo pipefail <<'TEARDOWN'
export AWS_REGION=eu-central-1
one() { # KIND PATTERN VALUE: exactly one id of that shape, or stop
  [[ "$3" =~ ^$2$ ]] || { echo "REFUSED: expected exactly one $1 id, got '$3'" >&2; exit 1; }
}
[[ "${SUFFIX:-}" =~ ^[a-z0-9]{4,20}$ ]] || { echo "REFUSED: SUFFIX not set" >&2; exit 1; }
ID=$(aws ec2 describe-instances --filters Name=tag:Project,Values=slax Name=tag:Name,Values=slax-prod \
     Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Project,Values=slax Name=tag:Name,Values=slax-prod --query 'Addresses[].AllocationId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=tag:Project,Values=slax Name=group-name,Values=slax-prod --query 'SecurityGroups[].GroupId' --output text)
one instance 'i-[0-9a-f]{8,17}' "$ID"
one elastic-ip 'eipalloc-[0-9a-f]{8,17}' "$ALLOC"
one security-group 'sg-[0-9a-f]{8,17}' "$SG"
echo "Deleting instance $ID, Elastic IP $ALLOC, security group $SG, role slax-prod-instance, buckets slax-*-$SUFFIX"
read -r -p "Type 'delete slax-prod' to go ahead: " answer </dev/tty
[ "$answer" = "delete slax-prod" ] || { echo "not confirmed" >&2; exit 1; }

# 0. Keep a last backup elsewhere first if the data matters (aws s3 cp of the newest dump).
# 1. The instance (and its root volume, DeleteOnTermination).
aws ec2 modify-instance-attribute --instance-id "$ID" --no-disable-api-termination
aws ec2 terminate-instances --instance-ids "$ID" >/dev/null && aws ec2 wait instance-terminated --instance-ids "$ID"
# 2. The Elastic IP (billed while it exists), then the security group.
aws ec2 release-address --allocation-id "$ALLOC"
aws ec2 delete-security-group --group-id "$SG"
# 3. IAM.
aws iam remove-role-from-instance-profile --instance-profile-name slax-prod-instance --role-name slax-prod-instance
aws iam delete-instance-profile --instance-profile-name slax-prod-instance
aws iam delete-role-policy --role-name slax-prod-instance --policy-name slax-prod-s3
aws iam delete-role --role-name slax-prod-instance
# 4. Buckets: files (not versioned), then backups (every version and delete marker, 1000 at a time).
aws s3 rm "s3://slax-files-$SUFFIX" --recursive --only-show-errors
aws s3api delete-bucket --bucket "slax-files-$SUFFIX"
B="slax-backups-$SUFFIX"
while :; do
  aws s3api list-object-versions --bucket "$B" --max-items 1000 --output json \
    --query '{Objects: [Versions[].{Key: Key, VersionId: VersionId}, DeleteMarkers[].{Key: Key, VersionId: VersionId}][] | [?Key]}' > /tmp/slax-versions.json
  grep -q '"Key"' /tmp/slax-versions.json || break
  aws s3api delete-objects --bucket "$B" --delete file:///tmp/slax-versions.json >/dev/null
done
rm -f /tmp/slax-versions.json
aws s3api delete-bucket --bucket "$B"
echo "Torn down."
TEARDOWN
```

Then: remove the `slax-prod` machine in the Tailscale admin console, the A record, the
GitHub environment `production`, and the production redirect URI in Google Cloud.

## 7. Verification checklist

Brief step 4, to run once production exists (none of it could be run when this was written:
no AWS access). Tick each item.

1. [ ] `deploy/aws/provision.sh --dry-run` on the provisioned account lists 7 resources as
   `exists`, and a second real run creates nothing.
2. [ ] `curl -sI https://slax.yechpa.com` → `HTTP/2 200` with `content-security-policy:`
   (`default-src 'self'`, `img-src` naming `slax-files-<suffix>.s3.eu-central-1.amazonaws.com`),
   `strict-transport-security: max-age=31536000; includeSubDomains`, `x-content-type-options: nosniff`.
   `curl -sI http://slax.yechpa.com` → 308 to https. `curl -s -o /dev/null -w '%{http_code}' https://slax.yechpa.com/apps/x` → 404.
3. [ ] `curl -s https://slax.yechpa.com/api/v1/health` → `{"status":"ok"}`.
4. [ ] Sign in with Google in a browser; post a message; a second browser sees it live
   (WebSocket through Caddy); upload an image: its preview loads from the bucket's S3 host
   (DevTools → Network), a `.txt` downloads as an attachment; the console shows no CSP error.
5. [ ] Client address: as an administrator, Administration → Audit shows your own public IP
   for your actions (not 10.42.x.x, not the Elastic IP). `curl -H 'X-Forwarded-For: 6.6.6.6' https://slax.yechpa.com/api/v1/health`
   followed by an audited action from that client never records 6.6.6.6.
6. [ ] From outside the tailnet: `nc -vz -w 5 <Elastic IP> 22` and `… 6443` time out; on the
   tailnet `kubectl get nodes` works through the MagicDNS name.
7. [ ] **Before tagging v0.1.0** (moto and MinIO enforce no IAM, so nothing local proves the
   role's policy). No Slax pod exists yet, so use a one-off pod of the very image you are about
   to release (a `main` sha whose Images run is green; it contains `slax:s3-probe`). It runs in
   the `default` namespace on purpose: no Pod Security restriction, no network policy, and the
   instance role is reachable as from the app (IMDSv2, hop limit 2); `--rm` deletes it:

   ```sh
   tailscale ssh ubuntu@slax-prod -- sudo k3s kubectl run slax-s3-probe -n default --rm -i --restart=Never \
     --image=ghcr.io/yechpa/slax-app:<sha> \
     --env=AWS_DEFAULT_REGION=eu-central-1 --env=AWS_BUCKET=slax-files-<suffix> --env=LOG_CHANNEL=stderr \
     -- php artisan slax:s3-probe
   ```

   → `PASS: put, get and delete of files/probe/slax-s3-probe-….txt in bucket slax-files-<suffix>`.
   The probe writes through Flysystem exactly as uploads do (same `x-amz-acl: private` header,
   same bucket, under `files/`) with the disk's `throw` forced on (the app's default
   `throw => false` turns a refusal into a silent `false`). `FAIL at put (…): AccessDenied
   (Aws\S3\Exception\S3Exception)` means the role policy is wrong (for instance without
   `s3:PutObjectAcl`): re-run provision.sh and probe again. After the first release and the
   first backup, also `kubectl -n slax exec deploy/slax-scheduler -- php artisan backups:check-freshness`
   → "The newest backup is N hours old", then an actual upload in the app (item 4).
7a. [ ] All four packages are public: logged out (`DOCKER_CONFIG=$(mktemp -d)`),
   `docker buildx imagetools inspect ghcr.io/yechpa/slax-backup:<sha>` works (§3.9).
7b. [ ] On the node: `sudo slax-edge-guard status` → `ens5 guarded`; `systemctl is-active slax-edge-guard k3s caddy`.
7c. [ ] No static AWS key anywhere: `kubectl -n slax get deploy,cronjob -o yaml | grep -c AWS_ACCESS_KEY_ID` → 0;
   an upload works (instance role).
8. [ ] Release `v0.1.0` (3.11): `check` green, approval requested, `deploy` green, Telegram
   `[Prod] Release v0.1.0 … is live`.
9. [ ] Deliberately failing deploy, Helm's own rollback: by hand, the current sha with a web
   container that cannot start (8 MiB of memory), while a loop watches the site:

   ```sh
   while sleep 1; do curl -s -o /dev/null -w '%{http_code}\n' https://slax.yechpa.com/api/v1/health; done   # another terminal
   helm upgrade slax deploy/helm/slax -n slax -f deploy/helm/slax/values-prod.yaml --set image.tag=<deployed sha> \
     --set s3.bucket=slax-files-<suffix> --set backup.bucket=slax-backups-<suffix> \
     --set app.web.resources.requests.memory=8Mi --set app.web.resources.limits.memory=8Mi --atomic --wait --timeout 4m
   ```

   The upgrade fails, `helm -n slax history slax` shows the failed revision and a newer
   `Rollback to N`, and the loop never stops printing 200 (`maxUnavailable: 0`).
10. [ ] Deliberately failing release, the workflow's explicit rollback: on the node, comment
    out the `Strict-Transport-Security` line in `/etc/caddy/Caddyfile`,
    `sudo systemctl reload caddy`; in Actions, *Re-run all jobs* of the last *Release prod*
    run and approve. Helm succeeds, the post-deploy check fails on HSTS, the workflow runs
    `helm rollback slax <previous revision>`, and Telegram says
    `FAILED its post-deploy checks: ROLLED BACK to revision N`. Restore the line, reload
    Caddy, re-run once more: `is live`.
11. [ ] Backups: `kubectl -n slax create job --from=cronjob/slax-backup slax-backup-manual-1`
    completes; the dump appears under `s3://slax-backups-<suffix>/pg/<today>/`; then
    `kubectl -n slax create job --from=cronjob/slax-restore-check slax-restore-check-manual-1`
    completes and Telegram says `[Prod] Weekly restore check OK: … N users, M migrations`.
12. [ ] The following Sunday, the scheduled restore check reports by itself.
13. [ ] Caddy certificate: `openssl s_client` (§5) shows a Let's Encrypt certificate valid
    for about 90 days; `systemctl list-timers` shows `k3s-image-prune.timer` and
    `apt-daily-upgrade.timer`.
14. [ ] Memory after a day: `free -m` available > 200 MiB, `vmstat` si/so ≈ 0; otherwise plan
    t4g.medium (§2, §4.9). Compare `free -m` "used" with §2's estimate (≈ 1.25 GiB).
15. [ ] `aws ec2 describe-instances --instance-ids <wa-bot id>` is exactly as before (state,
    security groups, tags): provisioning never touched it.
16. [ ] Uptime monitor: `kubectl -n slax logs -l app.kubernetes.io/component=monitor --tail=3` →
    `uptime: app=ok reverb=ok postgres=ok redis=ok public=ok disk:node=NN% disk:volumes=same-as-node`.
    `public=ok` proves a pod reaches the instance's own Elastic IP through the Internet
    gateway; if it says `FAIL(timeout)` while the site works from outside, set
    `monitor.checkPublicUrl: false` in values-prod.yaml and rely on the release checks.
17. [ ] Its alert path, end to end, as in §4.10 (Reverb down four minutes): one `[Prod] DOWN: reverb`
    and one `[Prod] RECOVERED: reverb` message, nothing else.
