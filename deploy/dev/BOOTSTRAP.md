# Bootstrapping the development cluster (`slax-dev`)

The development environment is a single-node k3s cluster on `slax-dev` (Ubuntu 24.04,
amd64), reachable **only on the tailnet** at `https://dev.slax.yechpa.com`. Once this guide
is done, every push to `main` deploys itself:

```
push to main ──> Images (.github/workflows/images.yml)
                   builds slax-app / slax-web / slax-scanner for amd64 and arm64,
                   scans them, pushes ghcr.io/yechpa/slax-*:<sha>
             ──> Deploy dev (.github/workflows/deploy-dev.yml)
                   joins the tailnet (ephemeral tag:ci node), helm upgrade --install,
                   GET /api/v1/health until 200, Telegram "[Dev] Deploy OK/FAILED <sha>"
```

Steps marked **YOU DO THIS** need your accounts, your server or your secrets: nothing in the
repository can do them for you. Commands run on `slax-dev` unless they say otherwise. Never
paste a secret into a command line, a file in the repository, an issue or a chat: the
commands below read secrets at hidden prompts.

Contents:
1. [Second disk](#1-second-disk-mntssd)
2. [k3s on the second disk](#2-k3s-on-the-second-disk)
3. [Tailscale](#3-tailscale)
4. [DNS and what is exposed](#4-dns-and-what-is-exposed)
5. [Helm and cert-manager](#5-helm-and-cert-manager)
6. [Certificates: ClusterIssuer with DNS-01](#6-certificates-clusterissuer-with-dns-01)
7. [Namespace and the CI deployer](#7-namespace-and-the-ci-deployer)
8. [Application secrets](#8-application-secrets)
9. [GitHub: environment, secrets, packages](#9-github-environment-secrets-packages)
10. [First deployment](#10-first-deployment)
11. [Verification checklist](#11-verification-checklist-end-to-end)
12. [Rollback](#12-rollback)
13. [Backups (dev)](#13-backups-dev)
14. [Rotating secrets](#14-rotating-secrets)
15. [Troubleshooting](#15-troubleshooting)

What the chart deploys (namespace `slax`): the web pod (nginx `slax-web` + PHP-FPM
`slax-app`), Reverb, one queue worker, one scheduler, the upload scanner, PostgreSQL 16,
Redis 7 and MinIO (dev only), a migration Job on every deploy, network policies and a
Traefik ingress with a cert-manager certificate. See `deploy/helm/slax/values.yaml` and
`values-dev.yaml`.

---

## 1. Second disk (`/mnt/ssd`)

Everything Kubernetes writes in bulk (container images, volumes) goes to the second disk,
never to the system disk. You already mounted it by UUID; check it.

**YOU DO THIS**

```sh
findmnt /mnt/ssd                       # must show the second disk's partition
grep -E '[[:space:]]/mnt/ssd[[:space:]]' /etc/fstab   # must start with UUID=..., not /dev/sdX
lsblk -f                               # the UUID in fstab is the partition mounted on /mnt/ssd
df -h /mnt/ssd
```

`UUID=` matters: device names (`/dev/sdb1`) can swap between boots. The fstab line should
carry `nofail` only if you accept booting without the disk; k3s is protected anyway (next
step).

## 2. k3s on the second disk

k3s is installed (v1.36.5, data directory `/mnt/ssd/k3s`). Make its configuration explicit
in `/etc/rancher/k3s/config.yaml` (read at every start, merged with any flags given at
install time).

**YOU DO THIS**

1. Find the node's Tailscale address and name (step 3 installs Tailscale if it is not
   there yet; come back here after it):

   ```sh
   tailscale ip -4          # 100.x.y.z
   tailscale status --self  # the MagicDNS name, e.g. slax-dev
   ```

2. Write the configuration (replace `100.x.y.z`):

   ```sh
   sudo install -d -m 0755 /etc/rancher/k3s /mnt/ssd/k3s-storage
   sudo tee /etc/rancher/k3s/config.yaml >/dev/null <<'EOF'
   # Containerd images, k3s state: on the second disk.
   data-dir: /mnt/ssd/k3s
   # Volumes (PostgreSQL, Redis, MinIO) of the local-path provisioner: also on the second
   # disk, outside the data directory, so reinstalling k3s never touches them.
   default-local-storage-path: /mnt/ssd/k3s-storage
   # The API server's certificate must name the address CI connects to over the tailnet.
   tls-san:
     - 100.x.y.z
     - slax-dev
   write-kubeconfig-mode: "0600"
   EOF
   ```

3. Never start k3s without the disk (it would silently recreate an empty data directory on
   the system disk):

   ```sh
   sudo install -d /etc/systemd/system/k3s.service.d
   sudo tee /etc/systemd/system/k3s.service.d/mount.conf >/dev/null <<'EOF'
   [Unit]
   RequiresMountsFor=/mnt/ssd
   EOF
   sudo systemctl daemon-reload
   sudo systemctl restart k3s
   ```

4. Verify:

   ```sh
   systemctl show k3s -p RequiresMountsFor        # RequiresMountsFor=/mnt/ssd
   systemctl cat k3s | grep -E 'ExecStart|mount.conf'
   sudo k3s kubectl get nodes                      # Ready
   sudo du -sh /mnt/ssd/k3s/agent/containerd       # images are here
   sudo k3s kubectl -n kube-system get configmap local-path-config \
     -o jsonpath='{.data.config\.json}'; echo      # "paths":["/mnt/ssd/k3s-storage"]
   ```

   If `local-path-config` still shows another path, the cluster was first started without
   the option: edit it once with
   `sudo k3s kubectl -n kube-system edit configmap local-path-config` (set `paths` to
   `["/mnt/ssd/k3s-storage"]`); no volume exists yet, so nothing has to move.

   What stays on the system disk: `/var/lib/kubelet` (pods' small `emptyDir` volumes, each
   capped by the chart) and `/var/log/pods` (container logs, rotated by the kubelet).

5. Optional, so `kubectl`/`helm` work without `sudo k3s` for your user:

   ```sh
   mkdir -p ~/.kube && sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config && chmod 600 ~/.kube/config
   ```

   The commands below write `sudo k3s kubectl`; with this file, plain `kubectl` does the same.

## 3. Tailscale

**YOU DO THIS**

1. In the tailnet policy file (Tailscale admin console → Access controls), declare the two
   tags and allow CI to reach the dev node on the Kubernetes API (6443) and HTTPS (443)
   **only**. Merge this into your policy; keep your own rules for your devices. If your
   policy is still the default "allow everything" rule, replace it with explicit rules,
   otherwise `tag:ci` can reach every device you own.

   ```jsonc
   {
     "tagOwners": {
       "tag:slax-dev": ["autogroup:admin"],
       "tag:ci":       ["autogroup:admin"],
     },
     "acls": [
       // Your own devices (adapt): everything on the dev server.
       {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:slax-dev:*"]},
       // GitHub Actions: the Kubernetes API and the site, nothing else, nowhere else.
       {"action": "accept", "src": ["tag:ci"], "dst": ["tag:slax-dev:443,6443"]},
     ],
     "tests": [
       {"src": "tag:ci", "accept": ["tag:slax-dev:443", "tag:slax-dev:6443"], "deny": ["tag:slax-dev:22", "tag:slax-dev:80"]},
     ],
   }
   ```

   (With the newer `grants` syntax the CI rule is
   `{"src": ["tag:ci"], "dst": ["tag:slax-dev"], "ip": ["tcp:443", "tcp:6443"]}`.)

2. Install Tailscale on `slax-dev` (official package repository for Ubuntu 24.04, see
   <https://tailscale.com/kb/1031/install-linux>), then join with the server's tag:

   ```sh
   sudo tailscale up --advertise-tags=tag:slax-dev
   tailscale ip -4
   ```

   In the admin console → Machines → `slax-dev`: **Disable key expiry** (a server must not
   drop off the tailnet when its key expires).

3. Create the OAuth client CI joins with: admin console → Settings → OAuth clients →
   Generate. Scope: **Auth Keys: Write**, tag **`tag:ci`** only. Keep the client ID and the
   secret for step 9 (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`). Each workflow run then
   registers an *ephemeral* node tagged `tag:ci`, removed automatically when the run ends.

## 4. DNS and what is exposed

The dev site has a public name that resolves to a private (tailnet) address: only devices
on your tailnet can connect, and the certificate is obtained by DNS-01, so **no port is
open to the Internet**.

**YOU DO THIS**: in yechpa.com's DNS, two `A` records pointing to the Tailscale IPv4 of
`slax-dev` (`tailscale ip -4`):

| Name                         | Type | Value        | What                                   |
|------------------------------|------|--------------|----------------------------------------|
| `dev.slax.yechpa.com`        | A    | `100.x.y.z`  | the app                                |
| `files.dev.slax.yechpa.com`  | A    | `100.x.y.z`  | file downloads (MinIO, its own origin) |

Check from any machine: `dig +short dev.slax.yechpa.com` → `100.x.y.z`.

How Traefik is reached: k3s runs Traefik behind its built-in ServiceLB, which listens on
ports 80 and 443 of **every** address of the node: the Tailscale address, and also the LAN
address. Nothing reaches it from the Internet as long as your router forwards no port to
`slax-dev` (**YOU DO THIS**: check that it does not). The ingress serves HTTPS only (port 80
answers 404).

Optional hardening, so that even the LAN cannot reach 80, 443 and 6443 (only the tailnet
can): drop those ports when they arrive on the physical interface. Find its name with
`ip -br link` (e.g. `enp0s31f6`); the rule is in the `mangle` table so it applies before
Kubernetes' port mappings:

```sh
LAN_IF=enp0s31f6   # your interface
sudo iptables -t mangle -I PREROUTING -i "$LAN_IF" -p tcp -m multiport --dports 80,443,6443 -j DROP
# Persist it (re-applied at boot, before k3s):
sudo tee /etc/systemd/system/slax-lan-guard.service >/dev/null <<EOF
[Unit]
Description=Drop 80/443/6443 arriving on the LAN interface (dev is tailnet-only)
Before=k3s.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iptables -t mangle -I PREROUTING -i $LAN_IF -p tcp -m multiport --dports 80,443,6443 -j DROP
ExecStop=/usr/sbin/iptables -t mangle -D PREROUTING -i $LAN_IF -p tcp -m multiport --dports 80,443,6443 -j DROP
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable slax-lan-guard
```

SSH (22) is not affected. Test from another LAN machine: `curl -k https://<LAN IP>` must
time out, while `curl https://dev.slax.yechpa.com/api/v1/health` from a tailnet device
answers (after step 10).

## 5. Helm and cert-manager

**YOU DO THIS**

1. Helm 3.22.1 on the server (checksum checked; the same version CI uses):

   ```sh
   cd /tmp
   curl -fsSLO https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz
   echo "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea  helm-v3.22.1-linux-amd64.tar.gz" | sha256sum -c -
   tar -xzf helm-v3.22.1-linux-amd64.tar.gz linux-amd64/helm
   sudo install -m 0755 linux-amd64/helm /usr/local/bin/helm && rm -rf linux-amd64 helm-v3.22.1-linux-amd64.tar.gz
   helm version --short
   ```

   Helm needs a kubeconfig: `~/.kube/config` from step 2.5, or prefix the commands with
   `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml`.

2. cert-manager, pinned (v1.21.3), with its CRDs. Its DNS-01 self-check asks public
   resolvers directly, so the node's own DNS settings (Tailscale's MagicDNS) never get in
   the way:

   ```sh
   helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
     --version v1.21.3 --namespace cert-manager --create-namespace \
     --set crds.enabled=true \
     --set 'extraArgs={--dns01-recursive-nameservers-only,--dns01-recursive-nameservers=1.1.1.1:53\,8.8.8.8:53}' \
     --wait
   kubectl -n cert-manager get pods     # three pods Running
   ```

## 6. Certificates: ClusterIssuer with DNS-01

Let's Encrypt proves you own `dev.slax.yechpa.com` through a TXT record that cert-manager
writes with your DNS provider's API. **The DNS provider and its credentials are yours:**
the repository only has an example (`deploy/dev/cluster-issuer.example.yaml`, Cloudflare).

**YOU DO THIS**

1. Create an API credential at your DNS provider, limited to editing DNS records of
   `yechpa.com` (Cloudflare: an API token with *Zone → DNS → Edit* on that zone only). For
   another provider (Route 53, OVH, Gandi, ...), adapt the `solvers` block following
   <https://cert-manager.io/docs/configuration/acme/dns01/>.

2. Store it in the cert-manager namespace (hidden prompt; never on a command line):

   ```sh
   read -rs -p 'DNS API token: ' DNS_TOKEN; echo
   kubectl -n cert-manager create secret generic dns-provider-credentials \
     --from-file=api-token=<(printf '%s' "$DNS_TOKEN")
   unset DNS_TOKEN
   ```

3. Copy the example outside the repository, put your ACME account e-mail in place of
   `<ACME_ACCOUNT_EMAIL>`, apply:

   ```sh
   cp deploy/dev/cluster-issuer.example.yaml /tmp/cluster-issuer.yaml
   nano /tmp/cluster-issuer.yaml
   kubectl apply -f /tmp/cluster-issuer.yaml && rm /tmp/cluster-issuer.yaml
   kubectl get clusterissuer        # letsencrypt-dns and letsencrypt-dns-staging: READY True
   ```

   `values-dev.yaml` uses `letsencrypt-dns`. For a first try without risking Let's
   Encrypt's rate limits, deploy once with `--set ingress.tls.clusterIssuer=letsencrypt-dns-staging`
   (the browser will distrust that certificate), then go back to the default.

## 7. Namespace and the CI deployer

Get the repository on the server (it is public): `git clone https://github.com/yechpa/slax.git && cd slax`.

**YOU DO THIS**

```sh
kubectl apply -f deploy/dev/deployer-rbac.yaml
```

This creates the namespace `slax` (Pod Security Standard *restricted* enforced: every Slax
pod complies) and the identity GitHub Actions deploys with: a ServiceAccount whose Role only
covers what the chart manages, in this namespace only (no cluster-wide access, no nodes, no
RBAC, no other namespace).

Build its kubeconfig (the token stays in shell variables and a private file, never on a
command line):

```sh
NODE=100.x.y.z    # the Tailscale IPv4 of slax-dev (listed in tls-san, step 2)
TOKEN="$(kubectl -n slax get secret slax-deployer-token -o jsonpath='{.data.token}' | base64 -d)"
CA="$(kubectl -n slax get secret slax-deployer-token -o jsonpath='{.data.ca\.crt}')"
umask 077
cat > /tmp/slax-deployer.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: slax-dev
    cluster:
      server: https://${NODE}:6443
      certificate-authority-data: ${CA}
users:
  - name: slax-deployer
    user:
      token: ${TOKEN}
contexts:
  - name: slax-dev
    context: {cluster: slax-dev, user: slax-deployer, namespace: slax}
current-context: slax-dev
EOF
unset TOKEN CA
KUBECONFIG=/tmp/slax-deployer.kubeconfig kubectl auth can-i create deployments -n slax        # yes
KUBECONFIG=/tmp/slax-deployer.kubeconfig kubectl auth can-i create deployments -n kube-system # no
base64 -w0 /tmp/slax-deployer.kubeconfig > /tmp/slax-deployer.kubeconfig.b64
```

Step 9 stores `/tmp/slax-deployer.kubeconfig.b64` as `DEV_KUBECONFIG`, then deletes both
files.

## 8. Application secrets

All secret values live in one Secret, `slax/slax-secrets`, created by hand. The chart only
refers to it by name; nothing secret is ever in the repository.

**YOU DO THIS** first, outside the server:

- **Google sign-in**: in Google Cloud Console, an OAuth client of type *Web application*
  (consent screen in production, scopes `openid email profile`). Authorized redirect URI:
  `https://dev.slax.yechpa.com/auth/google/callback` (add the production one,
  `https://slax.yechpa.com/auth/google/callback`, when Task 13 gets there).
- **Cloudflare Turnstile**: a widget (mode *Managed*) whose hostnames include
  `dev.slax.yechpa.com` (and later `slax.yechpa.com`). Cloudflare's always-pass test keys
  also work on dev if you prefer (sign-in then never challenges anyone).
- **Telegram** (optional, for alerts): the bot token and the chat id of your private chat
  with the bot. Dev and prod share them; every message starts with `[Dev]` or `[Prod]`.
- **Administrators** (optional): the Google addresses, comma separated (`ADMIN_EMAILS`).

Then on the server:

```sh
sudo deploy/dev/create-secrets.sh
```

It generates `APP_KEY`, `DB_PASSWORD`, `REDIS_PASSWORD`, `REVERB_APP_KEY`,
`REVERB_APP_SECRET` and the MinIO keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), and
asks, without echo, for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET`, then optionally `ADMIN_EMAILS`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID` (Enter skips). Values go to kubectl as files in a private temporary
directory that is deleted afterwards.

| Key | Required | Used by |
|---|---|---|
| `APP_KEY` | yes (generated) | Laravel encryption |
| `DB_PASSWORD` | yes (generated) | PostgreSQL, Laravel |
| `REDIS_PASSWORD` | yes (generated) | Redis, Laravel |
| `REVERB_APP_KEY` | yes (generated; public, sent to browsers) | Reverb, Laravel, the page |
| `REVERB_APP_SECRET` | yes (generated) | Reverb, Laravel |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | yes (generated for MinIO) | MinIO root user, Laravel |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | Google sign-in |
| `TURNSTILE_SITE_KEY` | yes (public, sent to browsers) | the page |
| `TURNSTILE_SECRET` | yes | Laravel |
| `ADMIN_EMAILS` | no | administrators |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no (no alerts without them) | alerts |

## 9. GitHub: environment, secrets, packages

**YOU DO THIS** (on your machine, with `gh` logged in as the repository owner, or in the
web UI).

1. Create the environment `dev` (Settings → Environments → New environment), with
   *Deployment branches and tags* limited to `main`. Its secrets are then only given to
   jobs deploying from `main`.

2. Its secrets (`gh` prompts for each value without echo):

   ```sh
   gh secret set TS_OAUTH_CLIENT_ID --env dev --repo yechpa/slax
   gh secret set TS_OAUTH_SECRET    --env dev --repo yechpa/slax
   gh secret set TELEGRAM_BOT_TOKEN --env dev --repo yechpa/slax
   gh secret set TELEGRAM_CHAT_ID   --env dev --repo yechpa/slax
   ```

   And the deployer kubeconfig, from the server (copy the `.b64` file over SSH on the
   tailnet, or run `gh` there), then delete it everywhere:

   ```sh
   gh secret set DEV_KUBECONFIG --env dev --repo yechpa/slax < /tmp/slax-deployer.kubeconfig.b64
   shred -u /tmp/slax-deployer.kubeconfig /tmp/slax-deployer.kubeconfig.b64
   ```

   | Secret | What |
   |---|---|
   | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | Tailscale OAuth client (Auth Keys: Write, `tag:ci`) |
   | `DEV_KUBECONFIG` | base64 of the deployer kubeconfig (step 7) |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | deploy alerts (optional: without them, no alert) |

   The image workflow needs no secret: it pushes with the run's own `GITHUB_TOKEN`.

3. After the first `Images` run on `main`, make the three packages public (the cluster pulls
   them without credentials): github.com/yechpa?tab=packages → `slax-app` → Package
   settings → Change visibility → Public. Same for `slax-web` and `slax-scanner`. Check:
   `docker pull ghcr.io/yechpa/slax-app:<sha>` works while logged out.

## 10. First deployment

Do the first one by hand on the server, to watch it; afterwards CI does the same on every
push to `main`. Use the SHA of a `main` commit whose `Images` run succeeded (the newest:
`git ls-remote https://github.com/yechpa/slax.git refs/heads/main`).

```sh
SHA=<full commit sha>
helm upgrade --install slax deploy/helm/slax --namespace slax \
  -f deploy/helm/slax/values-dev.yaml --set image.tag="$SHA" \
  --atomic --wait --timeout 12m
kubectl -n slax get pods            # all Running; slax-migrate Completed
kubectl -n slax logs job/slax-migrate
kubectl -n slax get certificate     # slax-tls and slax-files-tls: READY True (can take 1-2 minutes)
```

The release is created on first install; the migration Job runs after it (PostgreSQL is
part of the release) and then before every upgrade. `--atomic` rolls an upgrade back if
anything fails to become ready.

From a device on the tailnet: `curl https://dev.slax.yechpa.com/api/v1/health` →
`{"status":"ok"}`.

## 11. Verification checklist (end to end)

Once steps 1-10 are done, check the whole chain (Task 12, step 5). Tick each line.

1. [ ] `make chart-lint` passes locally and the CI `chart` job is green on a pull request.
2. [ ] Merge a trivial pull request (e.g. a typo in a comment) into `main`.
3. [ ] Actions → **Images**: six builds (app, web, scanner × amd64, arm64) and three
       `manifest` jobs green; `docker buildx imagetools inspect ghcr.io/yechpa/slax-app:<sha>`
       lists `linux/amd64` and `linux/arm64`.
4. [ ] Actions → **Deploy dev** starts by itself after Images, joins the tailnet, `helm
       upgrade` succeeds, the health check gets 200.
5. [ ] Telegram: `[Dev] Deploy OK: <short sha> is live on dev.` with a link to the run. In
       the run's log, the token appears nowhere (search the log for a few characters of
       it: no match; `***` at most).
6. [ ] Tailscale admin console: during the run an ephemeral `tag:ci` machine appears, and it
       is gone after.
7. [ ] `helm -n slax history slax` shows the new revision with the commit's SHA as image
       tag (`kubectl -n slax get deploy slax-app -o jsonpath='{..image}'`).
8. [ ] In a browser on the tailnet, `https://dev.slax.yechpa.com`: valid certificate, sign in
       with Google, post in `#general`, open a thread, react, upload an image (its preview
       loads from `files.dev.slax.yechpa.com`), see another session's presence. DevTools →
       Console: no `Content-Security-Policy` violation; Network → WS: `/app/...` connected.
9. [ ] Headers: `curl -sI https://dev.slax.yechpa.com/ | grep -iE 'content-security|nosniff|referrer|permissions'`
       shows the CSP (`default-src 'self'`, `frame-ancestors 'none'`, ...), `nosniff`,
       `Referrer-Policy` and `Permissions-Policy`.
10. [ ] Reverb's HTTP API is not public: `curl -s -o /dev/null -w '%{http_code}\n' https://dev.slax.yechpa.com/apps/x/events` → `404`.
11. [ ] The scanner is reachable from the app only:
        `kubectl -n slax exec deploy/slax-scheduler -- php -r 'var_dump((bool) @fsockopen("slax-scanner", 8000, $e, $m, 3));'` → `bool(false)`;
        the same from `deploy/slax-app -c php` → `bool(true)`.
12. [ ] Not reachable outside the tailnet: from a phone on mobile data with Tailscale off,
        `https://dev.slax.yechpa.com` does not load.
13. [ ] Failure alert, once: in the Tailscale policy, temporarily remove the `tag:ci` rule;
        re-run the last *Deploy dev* run (Actions → Re-run jobs); it fails reaching the API
        and Telegram gets `[Dev] Deploy FAILED (failure): <sha>`. Put the rule back.
14. [ ] An error reaches Telegram: `kubectl -n slax exec deploy/slax-app -c php -- php artisan tinker --execute 'logger()->error("bootstrap check");'`
        → a `[Dev]` alert (needs the Telegram keys in `slax-secrets`).

## 12. Rollback

Every deployment is a Helm revision. To go back to the previous one:

```sh
helm -n slax history slax              # REVISION, image tag (app version), status
helm -n slax rollback slax <REVISION> --wait --timeout 10m
```

Migrations are not undone by a rollback: they follow *expand then contract* (each one
compatible with the previous release's code), so the older pods run on the newer schema.
A failed `helm upgrade --atomic` (by hand or in CI) already rolls itself back.

## 13. Backups (dev)

None are scheduled: dev data is disposable (the demo content is re-seeded on every deploy).
Production backups are Task 13. A manual dump when you want one:

```sh
kubectl -n slax exec slax-postgres-0 -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > slax-dev-$(date +%F).dump
# Restore into the (running) dev database:
kubectl -n slax exec -i slax-postgres-0 -- sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < slax-dev-YYYY-MM-DD.dump
```

Volumes live in `/mnt/ssd/k3s-storage` (one directory per volume). `helm uninstall slax`
keeps them (StatefulSet volume claims are never deleted by Helm); delete the claims
(`kubectl -n slax delete pvc --all`) to start from scratch.

## 14. Rotating secrets

- One application key: `sudo deploy/dev/create-secrets.sh set TELEGRAM_CHAT_ID` (any key),
  then `kubectl -n slax rollout restart deployment`. Do **not** rotate `DB_PASSWORD` or
  `REDIS_PASSWORD` this way: PostgreSQL keeps the password it was initialised with (change
  it in the database first with `ALTER ROLE`).
- The CI deployer token: `kubectl -n slax delete secret slax-deployer-token && kubectl apply -f deploy/dev/deployer-rbac.yaml`,
  then redo the kubeconfig (step 7) and `DEV_KUBECONFIG` (step 9).
- Tailscale OAuth client: generate a new one, update the two GitHub secrets, revoke the old one.

## 15. Troubleshooting

| Symptom | Look at | Usual cause |
|---|---|---|
| k3s does not start after a reboot | `systemctl status k3s`, `findmnt /mnt/ssd` | the disk is not mounted: by design (`RequiresMountsFor`); fix the mount |
| Pods `ImagePullBackOff` | `kubectl -n slax describe pod <pod>` | packages still private on GHCR (step 9.3), or the SHA has no image (Images failed) |
| Pod `CreateContainerConfigError` | `kubectl -n slax describe pod <pod>` | a required key missing from `slax-secrets` (step 8) |
| `helm upgrade` fails in `pre-upgrade hooks` | `kubectl -n slax logs job/slax-migrate` | a migration failed; the release is rolled back, the old pods keep running |
| Queue or scheduler restarted once on a fresh pod (`Operation timed out` to Redis) | `kubectl -n slax logs <pod> --previous` | the network policy for a brand-new pod is applied a few seconds after it starts; harmless |
| Certificate not `READY` | `kubectl -n slax describe certificate slax-tls`, `kubectl get challenges -A`, `kubectl -n cert-manager logs deploy/cert-manager` | DNS token rights, wrong zone in the issuer's `dnsZones`, or TXT propagation (wait) |
| Browser cannot resolve or reach `dev.slax.yechpa.com` | `dig +short dev.slax.yechpa.com`, `tailscale status` | device not on the tailnet; or a router/resolver with "DNS rebinding protection" drops answers in 100.64.0.0/10 (use another resolver, or Tailscale's MagicDNS with a split-DNS entry) |
| WebSocket drops every minute | browser DevTools → WS | Traefik's entry point timeouts: set `ports.websecure.transport.respondingTimeouts.readTimeout=0` in a `HelmChartConfig` for Traefik |
| `Origin not allowed` on the WebSocket | Reverb log | the page's host is not `publicHost` (`REVERB_ALLOWED_ORIGINS`) |
| CI cannot reach the API (`i/o timeout` to `100.x.y.z:6443`) | the run's Tailscale step, tailnet policy | ACL rule for `tag:ci`, or `tls-san` missing (x509 error) |
| Sign-in says "anti-bot check did not pass" | `kubectl -n slax logs deploy/slax-app -c php` | `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` not from the same widget, or the widget does not list `dev.slax.yechpa.com` |

Useful commands:

```sh
kubectl -n slax get pods,jobs,pvc,ingress,certificate
kubectl -n slax logs deploy/slax-app -c php        # Laravel (errors also go to Telegram)
kubectl -n slax logs deploy/slax-app -c web        # nginx access log
kubectl -n slax logs deploy/slax-reverb
kubectl -n slax exec -it deploy/slax-app -c php -- php artisan tinker
kubectl -n slax port-forward slax-minio-0 9001:9001   # MinIO console on http://localhost:9001
```
