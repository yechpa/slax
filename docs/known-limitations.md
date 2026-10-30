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

- **Audit IP behind a proxy.** `audit_logs.ip` is the request IP as Laravel resolves it. Until trusted proxies are
  configured for the production proxy (deployment task), every row there would carry the proxy's address.
- **Sessions from before the session index.** A ban destroys the sessions indexed per user at sign-in. A session
  opened before that index existed is not destroyed, but it is useless: `EnsureNotBanned` refuses every request of a
  banned user and logs that session out on its next request.
- **Locks are not pushed.** A lock (or unlock) reaches members at their next channel-list refresh (a minute at
  most) or when they open the channel; until then their composer still shows, and a post is refused with
  `channel_locked`, explained in words.
- **The demo reset is off by default.** `slax:demo-reset` deletes visitors' accounts and content, so it runs (on
  schedule or by hand) only where `SLAX_DEMO_RESET_ENABLED=true`: the public showcase only, set in its Helm values
  (Tasks 12/13). Elsewhere the command refuses unless `--force`; `make up` still seeds the demo content.
- **Banned demo accounts are kept** by the reset (their content goes): deleting one would let the person sign up
  again with the same Google account.
- **Alert grouping without Redis** is per host (file cache) and capped at about 5 alerts a minute, critical ones
  excepted: during a Redis outage, an alert over the cap waits for the next minute, and later ones keep being
  grouped. This fallback writes to `storage/framework/cache/data`, which must be writable by the PHP user; the
  production images run as non-root, so the deployment (Tasks 12/13) must provide a writable path there. Without
  it, alerts are silently dropped during a Redis outage (only the local log has them).
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
