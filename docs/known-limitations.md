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

## Realtime: Reverb's rate limit, and no connection cap

**Where:** `backend/config/reverb.php`, chart values `reverb.rateLimit`.

- **Per socket, every frame counts.** Reverb's limiter (enabled everywhere by default) counts each frame a socket
  sends, subscriptions and pings included, not only typing whispers: at most 300 per 60 s. Beyond, each frame is
  answered with pusher error 4301 and dropped; the socket stays open. A reconnection re-subscribing 30 channels
  and the presence channel, then typing for a minute at the client's pace (one whisper per 3 s), uses about a
  sixth of it (reverb-e2e test). A user in more than about 250 channels would see some subscriptions refused at
  each reconnection (no events for those channels until the next one): far beyond the demo's scale. *Intended
  fix if needed:* a whisper-only limit (Reverb has none; a custom `ClientEvent` handler would be needed).
- **What the limit does not stop.** The limit is per socket: a modified client gets 300 whispers relayed per
  minute on each socket it opens, so the relay is bounded per socket, not overall. Refused frames still cost
  Reverb a small error reply each.
- **Anyone can hold sockets.** Opening a socket needs no session (the Origin header is the browser's word, and a
  script sets its own), and subscribing it to a public channel name (any name without the `private-` or
  `presence-` prefix, such as `x`) needs no authorization: nothing in Slax broadcasts there, but the socket is
  held. Nothing limits how many: there is no per-IP limit at Caddy or nginx, and deliberately no Reverb
  connection cap (`max_connections`), because a cap is a lockout: one script filling it would get every new or
  reconnecting user refused with error 4004, which pusher-js never retries. The only bound is the Reverb pod's
  memory limit (256 MiB in dev, 192 MiB in prod): beyond it the pod is restarted, every client reconnects.
  *Next hardening step (not done):* a per-IP connection limit at nginx (`limit_conn` on `/app/`) or Caddy, or a
  custom Reverb channel manager refusing public channel names; not done because it cannot be tested here against
  the real Caddy -> nginx path (client addresses through the proxies).
- **The limiter's memory.** Reverb keeps each socket's counter in an in-process array cache that is not pruned
  when the socket closes: a few hundred bytes per socket ever opened since Reverb started. Negligible at the
  demo's scale; a Reverb restart (each deploy) clears it.
- **A refused connection is not retried.** When Reverb refuses a connection with a 4xxx error (over quota,
  application disabled, ...), pusher-js gives up: the tab shows the "Connection lost. Reconnecting…" banner, but
  does not reconnect until the page is reloaded (the channel list is still polled). No such refusal is
  configured in Slax today.

## Chat client: what is polled rather than pushed

**Where:** `frontend/src/components/Workspace.tsx`, `frontend/src/store/threads.ts`, `frontend/src/store/presence.ts`.

- **New conversations and invitations.** Nothing is pushed to a user who is added to a private room or a new
  conversation (there is no per-user event channel yet), so the client refetches `GET /channels` every minute while
  the tab is visible (never in a hidden tab), and once when the tab comes back after 15 s away. A conversation started by someone else therefore shows up within a
  minute, and its messages from then on are live. *Intended fix:* a `user.{id}` private channel with
  `channel.added`, which the "rekey" channel above would also need.
- **Thread summaries.** The server does not push a parent's `reply_count`/`last_reply_at` when a reply comes or
  goes; the client recomputes them from the replies' own events (each reply counted once). Two gaps remain until
  the next refresh of the channel: deleting the *latest* reply of a thread that is not open keeps the old "last
  reply" time (the previous reply's time is not known), and a reply event that arrives while the channel's page
  is loading, in the same second as the page's own last reply, is assumed to be counted by the page.
- **Presence** is polled every 30 s for the people on screen; the workspace presence channel only says who
  connected or disconnected (shown at once). Going idle, or coming back, shows for others at their next poll.
- **REST answers against live events.** Messages carry no version. A REST answer (a page, the answer to my
  reaction, edit or post) gives way, message by message, to the copy the client holds when a live event carrying
  the whole message reached it while the request was on its way (the event may be newer); an edit answer still
  applies its body when it is the newer edit, and a deletion always applies. A thread summary moved by a reply
  event is laid over the answer instead (the answer may be the repair of a stale count): a reply counts unless the
  answer's last reply is as recent, and a reply deleted during the request is assumed already left out of the
  answer (off by one at most until the next refresh, as for events held during a page load). This relies on every change being broadcast to every
  member, the requester included, in the order of the changes. The single queue worker (see below) keeps the
  order in which broadcasts are queued; two requests changing one message at the same moment could still queue
  theirs in the other order (as could several workers), and the older snapshot would show until the next change.
  *Intended fix:* a per-message version, bumped with every change (reply counts included) and compared on merge.
- **Older pages and events.** An event for a message that is not loaded yet is not kept anywhere (it would have
  nothing to merge into): if it arrives while the page holding that message (an older page of a channel or a
  thread) is on its way, the page's older copy shows until that message changes again. The window is the
  duration of one request, scrolled into history at that moment.
- **A private channel's name is not secret.** Channel names are unique across public and private channels (one
  index), so creating a channel under a private channel's name answers "taken": someone outside can learn that
  the name exists (not its content or members). Same trade-off as Slack; *intended fix if it matters:* names
  unique per kind, or private names hashed for the check.
- **"Name taken" is recognized by its message.** The API refuses a channel name in use with a validation
  message, and the client says "taken" in the reader's language only when it reads exactly
  `ChannelController::NAME_TAKEN` (pinned by tests on both sides). *Intended fix:* a stable error code.
- **Reactions beyond the 50 listed reactors.** A broadcast lists the first 50 reactors only, so for a reaction
  with more, whether I am one of them is kept from what the client knew (a REST answer, or my own toggle), never
  guessed from the broadcast.


## Installable app (PWA)

**Where:** `frontend/src/pwa/` (service worker, registration, update banner, install help),
`frontend/plugins/service-worker.ts`, `frontend/public/manifest.webmanifest`, `docker/web/slax.conf.template`,
`e2e/tests/pwa.spec.ts`.

- **Offline is the shell only.** The service worker precaches the page, the bundle, the fonts and the favicon (12
  files, about 420 KB, under 200 KB over the wire), so Slax opens offline and says "You're offline", then boots by
  itself when the network is back. Nothing can be read or sent offline: messages, channels and files are never
  cached (the API, sign-in, broadcasting auth, Reverb and every other origin, presigned S3 URLs included, are not
  touched by the worker at all). Offline reading would mean caching private data on the device, which this version
  refuses.
- **Verified in emulation only.** Playwright runs desktop Chromium: registration, the offline shell (with the worker
  itself offline), the update banner after a simulated deploy, and sign-out's cleanup, under the production CSP.
  The iOS Add to Home Screen help and Chromium's Install button are covered by unit tests (user agents and a fake
  `beforeinstallprompt`), not by a browser: headless Chromium does not offer installation, and the suite runs
  desktop Chromium only (WebKit and phone emulation come with the mobile pass). **To try on real devices:** install from Chrome on Android (account menu
  → Install Slax) and from Safari on an iPhone (the three steps), open from the icon, check the status bar colour in
  both themes, go to airplane mode and reopen (offline notice, then automatic recovery), deploy and check the banner
  appears when the app comes back to the foreground.
- **Safe areas come with the mobile pass.** `viewport-fit=cover` is set so the app can use the whole screen, but the
  safe-area padding (notch, home indicator) is the next task's work; until then, landscape on a notched iPhone can
  put the edges of the sidebar under the notch.
- **Where install is offered.** Chromium (Android, Windows, macOS, Linux) shows the Install button once the browser
  fires `beforeinstallprompt`; iPhone and iPad (Safari and the other iOS browsers) get the steps. Firefox desktop
  cannot install web apps, and Safari on macOS ("Add to Dock") is not detected: the menu says nothing there.
- **The update banner cannot be dismissed**, by design: an old app must not run unnoticed against a newer API.
  Reloading loses an unsent draft (drafts live in memory). Until the person reloads, the old version keeps working
  (old worker, old cache); any reload, by the banner or by hand, gets the newest page (navigations are network
  first). The browser checks for a new `sw.js` on navigations; the app also asks when it returns to the foreground
  and every hour.
- **Sign-out empties Cache Storage, not every trace.** All of the origin's caches are deleted at any session end
  (sign-out, expiry, ban), then the public shell is fetched again; API responses carry `Cache-Control: no-store`
  (nginx), so the HTTP cache keeps none either. The last open channel is forgotten too; local storage keeps only the
  language and theme chosen on the device (not private), and the browser's own history stays the browser's.
- **The icons are rendered from `favicon.svg`**, which is still Vite's default lightning logo. Replacing the favicon
  and running `make icons` regenerates every icon (a test fails while they are out of date).
- **The manifest is in English** (`lang: en`, name "Slax", the same in every language); the app itself follows the
  person's language once opened.

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

- **One small node.** t4g.small (2 GiB): at the brief's load (50 clients, 10 messages/s) the estimate is ≈ 1.25-1.3
  GiB (62-64 %), from k3s measured idle and the load measured on Compose, not from the instance itself (runbook §2,
  docs/load-test-results.md). A heavier use, the weekly restore check at the wrong moment or a memory leak would lean
  on the 2 GiB swap file; t4g.medium is the next step. A reboot (security updates at 02:00 UTC when needed) or a
  resize is a minute or two of downtime.
- **The app, queue, scheduler and backup pods can use the instance role** (IMDSv2 with hop limit 2, so containers
  reach the metadata service); Reverb, PostgreSQL, Redis and the migration Job are denied 169.254.169.254 by egress
  policies, the scanner has no egress at all. The role reaches only the two Slax buckets and cannot delete backups;
  a compromised app pod could still read or delete uploaded files, and a compromised app, queue or scheduler pod
  could read the database dumps in the backups bucket (the role may read `pg/`, for the backup jobs and the
  freshness check). Pods allowed to reach the metadata service can
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

## Uptime monitor and load test

**Where:** `deploy/monitoring/uptime.sh`, `deploy/helm/slax/templates/monitor-cronjob.yaml`, `e2e/load/`,
`docs/load-test-results.md`, runbook §2 and §4.10.

- **Nothing watches the watcher's node.** The monitor runs in the cluster: a dead node, k3s down or the instance cut
  from the Internet sends nothing. The silence (and the missing Sunday "restore check OK") is the signal. A free
  external pinger on `/api/v1/health` would close that gap; none is set up.
- **`/api/v1/health` is shallow** (nginx, PHP-FPM and Laravel's boot). The monitor checks PostgreSQL and Redis on
  their own, as "answering" (`pg_isready`, a bare `PING`), not as "Slax's queries work"; Administration → Status
  goes further (a query, a Redis ping, Reverb, the scanner, S3) but only for a signed-in administrator.
- **Only 3 failures in a row alert.** A check that flaps (fail, fail, pass, ...) never does; a restart that takes
  under three minutes is silent by design.
- **The monitor's pod may connect** to the web pod (8080), Reverb, PostgreSQL and Redis without any of their
  passwords. Like any pod on the pod network it could send a forged `X-Forwarded-For` to nginx, which believes the
  pod network (its own script sends none).
- **A pod a minute.** The CronJob creates 1,440 short Jobs a day (a few seconds of CPU each and some writes to k3s's
  datastore); one finished Job of each kind is kept. A long-running pod would be lighter but less isolated, and the
  brief asked for a CronJob.
- **Its volume claim is kept by Helm** (`helm.sh/resource-policy: keep`, because the CI deployer may not delete
  claims): `helm uninstall` leaves `slax-monitor` behind (`kubectl -n slax delete pvc slax-monitor`). Its size cannot
  change once created (local-path cannot resize).
- **Production's public check goes out and back in** through the Elastic IP (the pod reaches the instance's own
  public address through the Internet gateway). That this works is to be confirmed on the real node (runbook §7
  item 16); dev checks inside the cluster only.
- **The disk check sees filesystems,** not quotas: on the production node the volumes and the kubelet share the root
  disk (one `node` figure); on slax-dev they are two disks.
- **The load test ran on Compose, not on k3s** (development PHP image, x86, the generator on the same machine); the
  k3s figures are from an idle cluster. It covers sign-in, subscriptions, presence heartbeats and messages, not file
  uploads, typing whispers or reconnect storms. `make load` is manual; `make e2e` (and so CI) runs a 10-second smoke
  of it (5 clients) that fails on any loss or error.

