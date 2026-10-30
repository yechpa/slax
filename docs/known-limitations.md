# Known limitations

Accepted, documented gaps of Slax v1, each with the reason it is accepted and the intended fix.

## Realtime: a dishonest client can keep receiving a channel after removal

**Where:** `backend/app/Broadcasting/ReverbBroadcaster.php`,
`backend/app/Listeners/TerminateRevokedConnections.php`, `backend/routes/channels.php`.

**How revocation normally works.** `channel.{id}` is authorized live from channel membership. Each private-channel
authorization signs `channel_data = {"user_id": …}` into the subscription. When a member leaves or is removed,
`MemberRemoved` (after commit) calls Reverb's `POST /apps/{app}/users/{user}/terminate_connections`. That call
closes every socket that has a subscription tagged with that user id. The client reconnects, and its new
authorization request for the channel is refused.

**The attack.** A modified client, while it is still a member:

1. opens a second WebSocket, B, and subscribes it to nothing, so it carries no user id;
2. calls `POST /broadcasting/auth` with B's `socket_id` and `private-channel.{id}` and keeps the signature
   without using it. The signature is valid for that `(socket_id, channel, channel_data)` forever, because
   Pusher-protocol signatures do not expire.

After it is removed, the termination closes only the sockets tagged with its user id, so B survives. The client
then sends `pusher:subscribe` on B with the stored signature. Reverb only checks the HMAC, so it accepts, and B
receives the channel's events until it disconnects.

**Why it is accepted for v1:**

- It needs a deliberately modified client and a decision to prepare *before* the removal.
- Only events sent after the removal leak: new messages, edits and reactions. It gives no write access, no REST
  access (every API route checks membership on each request), and no history beyond what the member could
  already read.
- The surviving socket is lost on any disconnect: network change, Reverb restart, or deploy.
- The v1 deployment is a single small workspace.

**Intended fix (later): channel key rotation plus a per-user rekey channel.**

- Broadcast each channel on a versioned name, `channel.{id}.{epoch}`, with `epoch` stored on the channel and
  incremented on every removal or leave. A signature fetched for an older epoch then subscribes to a name nobody
  broadcasts on any more.
- Tell the remaining members about the new epoch on their own private channel, `user.{id}` (the "rekey"
  channel). Their clients then re-authorize and subscribe to the new name.
- Authorization for `channel.{id}.{epoch}` requires current membership *and* the current epoch.
- An alternative with the same shape is end-to-end encrypted channels (`private-encrypted-`) with a per-epoch
  shared secret.

## Chat client: what is polled rather than pushed

**Where:** `frontend/src/components/Workspace.tsx`, `frontend/src/store/threads.ts`, `frontend/src/store/presence.ts`.

- **New conversations and invitations.** Nothing is pushed to a user who is added to a private room or a new
  conversation (there is no per-user event channel yet), so the client refetches `GET /channels` every minute and
  when the tab comes back after 15 s away. A conversation started by someone else therefore shows up within a
  minute, and its messages from then on are live. *Intended fix:* a `user.{id}` private channel with
  `channel.added`, which the "rekey" channel above would also need.
- **Thread summaries.** The server does not push a parent's `reply_count`/`last_reply_at` when a reply comes or
  goes; the client recomputes them from the replies' own events (each reply counted once). Two gaps remain until
  the next refresh of the channel: deleting the *latest* reply of a thread that is not open keeps the old "last
  reply" time (the previous reply's time is not known), and a reply event that arrives while the channel's page
  is loading, in the same second as the page's own last reply, is assumed to be counted by the page.
- **Presence** is polled every 30 s for the people on screen; the workspace presence channel only says who
  connected or disconnected (shown at once). Going idle, or coming back, shows for others at their next poll.
- **Reactions beyond the 50 listed reactors.** A broadcast lists the first 50 reactors only, so for a reaction
  with more, whether I am one of them is kept from what the client knew (a REST answer, or my own toggle), never
  guessed from the broadcast.


## Administration, alerts and the demo reset

**Where:** `backend/app/Services/Moderation.php`, `backend/app/Services/UserSessions.php`,
`backend/app/Services/Alerts/TelegramNotifier.php`, `backend/app/Console/Commands/DemoReset.php`,
`backend/app/Services/AuditLogger.php`.

- **Audit IP behind a proxy.** `audit_logs.ip` is the request IP as Laravel resolves it (Laravel trusts no proxy:
  it reads REMOTE_ADDR). In the clusters, nginx (slax-web) takes the client address from `X-Forwarded-For` sent by
  the trusted proxies of `config.trustedProxies` (the k3s pod network). Production: Caddy on the host replaces any
  client `X-Forwarded-For` with the TCP peer and only the node reaches the web pod, so the address is the visitor's
  (`make proxy-test`). Dev: with k3s's ServiceLB in front of Traefik, the address Traefik sees may already be
  rewritten to a node address (dev is tailnet-only, so this only lumps the developers together).
- **Sessions from before the session index.** A ban destroys the sessions indexed per user at sign-in. A session
  opened before that index existed is not destroyed, but it is useless: `EnsureNotBanned` refuses every request of a
  banned user and logs that session out on its next request.
- **Locks are not pushed.** A lock (or unlock) reaches members at their next channel-list refresh (a minute at
  most) or when they open the channel; until then their composer still shows, and a post is refused with
  `channel_locked`, explained in words.
- **The demo reset is off by default.** `slax:demo-reset` deletes visitors' accounts and content, so it runs (on
  schedule or by hand) only where `SLAX_DEMO_RESET_ENABLED=true`: the public showcase only (`demo.resetEnabled`,
  true in `values-prod.yaml`, false in `values-dev.yaml`). Elsewhere the command refuses unless `--force`;
  `make up` still seeds the demo content.
- **Banned demo accounts are kept** by the reset (their content goes): deleting one would let the person sign up
  again with the same Google account.
- **Alert grouping without Redis** is per host (file cache) and capped at about 5 alerts a minute, critical ones
  excepted: during a Redis outage, an alert over the cap waits for the next minute, and later ones keep being
  grouped. This fallback writes to `storage/framework/cache/data`, which must be writable by the PHP user: the
  production image runs as non-root on a read-only root filesystem, and the Helm chart mounts an `emptyDir` on
  `storage/` (the image's entry point creates `framework/cache/data` in it). The cache is per pod and lost on
  restart, which only resets the grouping.
- **Audit retention.** Entries are kept 180 days (`SLAX_AUDIT_RETENTION_DAYS`), then pruned daily; refused sends
  are recorded once per sender and channel per 10 minutes.
- **The nightly demo reset is not pushed either.** Clients open at 03:00 keep showing the deleted messages until
  they reload or reopen the channel.
- **Conversations with a visitor are demo content.** The reset deletes every conversation that includes a demo
  account, an administrator's messages in it included.
- **Alerts lost on a fatal error.** During a request, an alert is sent after the response (deferred); a PHP fatal
  error (memory, timeout) before that point loses it, the local log keeps the error.
- **Locked channels and administrators.** Administrators still post in a locked channel they are a member of, so
  that they can explain the lock; a moderator who is not a member reads a public channel but posts nowhere.


## Deployment (Helm chart, images)

**Where:** `deploy/helm/slax/`, `docker/app/`, `docker/web/`, `.github/workflows/images.yml`,
`.github/workflows/deploy-dev.yml`, `deploy/dev/BOOTSTRAP.md`.

- **Reverb holds fewer secrets than the other Laravel pods** (its own keys, Redis's, the alert keys) and reaches
  Redis only; the app, queue, scheduler and migration pods get every secret key, since they run the whole API.
- **Single node, single replicas.** Reverb (no Redis scaling), the queue worker (ordering) and the scheduler run
  once, replaced with `Recreate`: a deployment drops WebSocket connections for a few seconds (clients reconnect).
  PostgreSQL and Redis restart only when their own settings change, not on an app deployment.
- **A deployment does not wait for the CI tests.** Deploy dev follows the Images workflow on `main`; the tests ran
  on the pull request before the merge (require them with branch protection).
- **Dev is tailnet-only by a host firewall rule, not by k3s.** k3s's ServiceLB and API server listen on every node
  address; the mandatory LAN guard (`deploy/dev/slax-lan-guard.sh`, BOOTSTRAP.md step 4.1, required by k3s) drops
  80/443/6443 on the interfaces listed in `/etc/default/slax-lan-guard`. A new physical interface (USB adapter,
  Wi-Fi switched on) is exposed to its LAN until it is added there (`systemctl reload slax-lan-guard`). Because
  k3s requires the guard, stopping or restarting the guard stops k3s. Nothing is forwarded from the Internet.
- **Image check names changed** (`build app (amd64)`, `push …`, `manifest …`, `tag …`): branch protection's
  required checks must use the new `build …` names.
- **Turnstile is allowed by the CSP on every page.** The SPA is one document, so `challenges.cloudflare.com` is in
  `script-src` and `frame-src` everywhere, not only on the sign-in screen.
- **Dev file downloads** come from MinIO on `files.dev.slax.yechpa.com`, with `nosniff` and a sandboxing CSP added
  by a Traefik middleware. **Production's** come from presigned URLs on the bucket's own S3 host
  (`https://slax-files-<suffix>.s3.eu-central-1.amazonaws.com`, a cross-site origin): S3 cannot add `nosniff` or a
  sandboxing CSP, so the protection is the forced `response-content-type` (the scanner's allowlist) and
  `attachment` for everything but images and PDFs. PDFs open inline on that isolated origin.
- **MinIO images are Chainguard's `latest`, pinned by digest** (upstream MinIO images are gone): the digest may be
  garbage-collected one day; dev only.
- **The first start of a pod can fail once** to reach Redis or PostgreSQL: k3s applies a network policy to a new pod
  a moment after it starts. The pod restarts and connects.
- **The images take Alpine's security updates at build time** (`apk upgrade` in slax-app), so two builds of the
  same commit can differ in OS packages. The Trivy gate fails on fixable critical vulnerabilities only.

## Production (AWS)

**Where:** `deploy/aws/`, `deploy/backup/`, `.github/workflows/release-prod.yml`, `docs/runbook.md`.

- **One small node.** t4g.small (2 GiB) holds k3s and every pod with a few hundred MiB to spare and a 2 GiB swap
  file; Task 14's load test decides whether t4g.medium is needed (runbook §2). A reboot (security updates at
  02:00 UTC when needed) or a resize is a minute or two of downtime.
- **The app, queue, scheduler and backup pods can use the instance role** (IMDSv2 with hop limit 2, so containers
  reach the metadata service); Reverb, PostgreSQL, Redis and the migration Job are denied 169.254.169.254 by egress
  policies, the scanner has no egress at all. The role reaches only the two Slax buckets and cannot delete backups;
  a compromised app pod could still read or delete uploaded files. Pods allowed to reach the metadata service can
  also read the instance's user data, with its spent single-use Tailscale key.
- **Uploads carry an ACL header.** Flysystem always sends `x-amz-acl: private`, so the role has `s3:PutObjectAcl`
  on the files objects. The bucket enforces the owner (ACLs disabled) and blocks public access, so the ACL changes
  nothing; that S3 accepts it is to be confirmed on the real bucket before the first release (runbook §7 item 7).
- **The web pod admits only its node**, relying on k3s's network policy engine (kube-router) always admitting
  node-local traffic (the same rule that lets kubelet probes in). Proven for probes in the dev k3s test; the Caddy
  path through the fixed ClusterIP is to be confirmed on the real node (runbook §7).
- **The node's Tailscale auth key stays in the instance's user data** (readable with `ec2:DescribeInstanceAttribute`,
  through the metadata service, and in cloud-init's root-only copy on disk). It is single use and short-lived, so it
  is worthless once the node has joined.
- **Two firewalls, both static**: the security group (TCP 80/443 only) and `slax-edge-guard` on the host (drops k3s's
  and SSH's ports on the public interface; k3s requires it, so stopping the guard stops k3s).
- **Caddy and k3s are pinned** (the `.deb` and the install script are checked against checksums at first boot) and
  are not updated by unattended-upgrades: updating them is a manual step. Tailscale updates itself.
- **No HTTP/3**: the security group opens TCP 80/443 only, so Caddy serves HTTP/1.1 and HTTP/2.
- **Backups are logical dumps, daily**: up to a day of data can be lost; there is no point-in-time recovery. The
  restore check restores only the newest dump. Besides the backup jobs' own alerts (failures, SIGTERM), the app
  checks every morning that the newest dump is under 30 hours old. All of these run in the cluster: a dead node
  sends nothing (the missing Sunday "restore check OK" message is the signal).
- **A release's checks run before approval only for the tag and the images**; Telegram is told about failed
  deployments, not about a tag refused by the `check` job (visible in GitHub Actions).
- **The release's post-deploy checks look at the public site**: an outage of Caddy or DNS during a release also
  triggers a rollback of a good release (harmless: re-run it).
