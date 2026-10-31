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
- Tell the remaining members about the new epoch on their own private channel, `App.Models.User.{id}` (the
  "rekey" event; the channel exists already, for `channel.added`). Their clients then re-authorize and subscribe
  to the new name.
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

**Where:** `frontend/src/components/Workspace.tsx`, `frontend/src/store/chat.ts`, `frontend/src/store/threads.ts`,
`frontend/src/store/presence.ts`.

- **New conversations and invitations: pushed, with the poll as a fallback.** A user whom someone else adds to a
  room, or puts in a new conversation, gets `channel.added` (the channel id only) on their own private channel
  `App.Models.User.{id}`, and the client refetches `GET /channels` at once. The event is not replayed: one missed
  while the socket is down is covered by the refetch after the reconnection, and anything else (a refused
  subscription, a queue delay) by the poll that stays: `GET /channels` every minute while the tab is visible (never
  in a hidden tab), and once when the tab comes back after 15 s away. A conversation started by someone else
  therefore shows up at once, at worst within a minute, and its messages from then on are live.
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
  itself offline), the update banner after a simulated deploy, the notices and toasts never covering each other or
  the composer (1280x800 and 375x667, English and Hebrew), and sign-out's cleanup, (the CSP is injected by the test as a copy of the production one, `PRODUCTION_CSP` in `e2e/tests/pwa.spec.ts`, and the other PWA e2e tests run without a CSP; `make web-check` is what pins `worker-src 'self'` in nginx itself). The iOS
  Add to Home Screen help and Chromium's Install button are covered by unit tests (user agents and a fake
  `beforeinstallprompt`), not by a browser: headless Chromium does not offer installation, and the service worker is
  tested in Chromium only (the WebKit phone project blocks it, see "Phones" below). **To try on real devices:** install from
  Chrome on Android (account menu → Install Slax) and from Safari on an iPhone (the three steps), open from the icon,
  check the status bar colour in both themes, go to airplane mode and reopen (offline notice, then automatic
  recovery), deploy and check the banner appears when the app comes back to the foreground.
- **Safe areas** (`viewport-fit=cover`): the notch, rounded corners and home indicator are padded by the styles; see
  "Phones" below for what was checked and how.
- **Where install is offered.** Chromium (Android, Windows, macOS, Linux) shows the Install button once the browser
  fires `beforeinstallprompt`; iPhone and iPad (Safari and the other iOS browsers) get the steps. Firefox desktop
  cannot install web apps, and Safari on macOS ("Add to Dock") is not detected: the menu says nothing there.
- **The update banner cannot be dismissed**, by design: an old app must not run unnoticed against a newer API. It
  shares one band above the screen with the connection notice (toasts hang just under it); the screen shrinks to make
  room, so neither covers the other, the composer, its Send or the header. Reloading loses an unsent draft (drafts
  live in memory). Until the person reloads, the old version keeps working (old worker, old cache); any reload, by
  the banner or by hand, gets the newest page (navigations are network first). The browser checks for a new `sw.js`
  on navigations; the app also asks when it returns to the foreground and every hour.
- **The band layout relies on CSS `:has()`.** Firefox before 121 and Safari before 15.4 do not support it: there the
  band stays in the page's flow but the screen keeps its full height, so the page scrolls and the composer is pushed
  down by the band's height while a notice shows.
- **Sign-out empties Cache Storage, not every trace.** All of the origin's caches are deleted at any session end
  (sign-out, expiry, ban), then the public shell is fetched again; API responses carry `Cache-Control: no-store`
  (nginx), so the HTTP cache keeps none either. The last open channel is forgotten at those and at a start-up that
  finds no session; local storage keeps only the language and theme chosen on the device (not private) and, with
  notifications on, the id of the account that turned them on (see "Push notifications"); the browser's own
  history stays the browser's.
- **A request in flight during sign-out cannot bring the session back.** Laravel saves the session at the end of
  every request, so a presence poll that left the page during `POST /auth/logout` wrote the old, signed-in session
  back after the logout destroyed it (seen in e2e runs). The logout now marks the session id as ended in Redis for
  the session's lifetime, and every authenticated request (`not-banned` middleware) refuses an ended session with a
  401. Other tabs' requests are covered the same way; a ban marks every session of the account the same way. On the
  page itself, the sign-out first pauses presence and holds every other request (those already out are waited for,
  3 s at most, then cut), so none even reaches the server after the logout. File uploads (XMLHttpRequest, for their
  progress) are not held: one still running is stopped when the screen closes, and the server-side mark covers it.
- **Signing out needs the server.** Offline, the logout cannot reach it: the person stays signed in, the app says
  "Could not sign out. Please try again." and works on. Clearing only this device would be false comfort: the
  session cookie (HttpOnly) is the server's to end, and the next start online would sign the previous person in
  again.
- **Sessions last 14 days without use, renewed by every request** (`session.lifetimeMinutes`, was 2 hours), so a
  notification tapped after a quiet week opens the conversation, not Google sign-in. The cost: a lost or shared
  device that nobody signs out of stays signed in that long after its last use (indefinitely while used); sign-out
  there, or a ban by an administrator, ends it at once. Only a signed-in session gets the 14 days: a session
  nobody signed in to (a visitor, a crawler, the CSRF cookie, a sign-in on its way) is kept 2 hours at most
  (`SESSION_DRIVER=redis-tiered`), and Redis evicts sessions and cache before it refuses writes (`volatile-lru`,
  never the queue; runbook 4.8). A flood of new visitors can therefore sign some people out, not stop the app.
  **No rate limit per address on session creation** (`GET /sanctum/csrf-cookie`, the app's first call): nginx's
  a `limit_req_zone $binary_remote_addr` on `/sanctum/csrf-cookie` and `/api/v1/auth` would work today (nginx already takes the visitor's address from the trusted `X-Forwarded-For` of Caddy, see `docker/web/entrypoint.sh`); it is simply not added yet. There is no "sign out everywhere" for oneself yet; an administrator's
  ban, then lifting it, does it (and also removes the account's notification devices).
- **After a deploy, a sign-out can leave no offline shell for a while.** The refill after a sign-out is all or
  nothing: the old worker still in control refills its own list, whose hashed files the deploy removed, so it gets
  404s and stores nothing (never a mixed cache). A new version already waiting refills its own cache at once; one not
  yet found fills it when it installs. Until that version takes over (the reload the banner offers, or every tab
  closed), the app works online only.
- **The icons are rendered from `favicon.svg`** (the `> _` prompt in the console's green on its background). Changing
  the favicon means running `make icons` (a test fails while the icons are out of date); how the mark looks once a
  launcher masks it is to be checked on the real phones.
- **The manifest is in English** (`lang: en`, name "Slax", the same in every language); the app itself follows the
  person's language once opened.

## Phones (iPhone and Android)

**Where:** `frontend/src/styles/` (`tokens.css` safe areas, `app.css`, `chat.css`, `utilities.css`),
`frontend/src/lib/viewport.ts` (on-screen keyboard), `frontend/src/lib/longPress.ts`, `frontend/index.html`,
`e2e/tests/mobile.spec.ts`, `e2e/support/mobile.ts`.

- **Emulation, not phones.** `make e2e` runs `mobile.spec.ts` in two more Playwright projects: `iphone` (WebKit with
  an iPhone 14's size, touch, user agent and scale) and `pixel` (Chromium as a Pixel 7). Neither is Safari on iOS nor
  Chrome on Android: same engines, none of their browser chrome, keyboards or gestures. Checked there: the viewport
  meta; the app exactly as tall as the window and the page never scrolling; fields of 16 px or more (iOS zooms on a
  smaller one); 44 x 44 px for the drawer toggle, channel details, attach, send, a message's "more" button, the menu
  items, the thread's buttons, the channels and the account menu; no sideways scroll at 375 and 360 px in English,
  Hebrew and French, both themes, with long words and a long link, drawer, menu and thread open; the drawer from the
  inline start (the right in Hebrew) and closed by a tap beside it; a message's menu by a tap on "more" or a long
  press; dialogs inside the screen, scrolling inside with their buttons in view; and the journey by touch (sign in,
  post, thread reply, reaction, conversation) in English on both and in Hebrew on the iPhone. The phones run that
  spec only, not the whole desktop suite (time).
- **The keyboard is emulated.** No headless browser has an on-screen keyboard: the test replaces
  `window.visualViewport` with one that shrinks by a keyboard's height (and pans, as Safari does) and checks that the
  composer, Send, the header, a thread's composer and a dialog stay inside what is left. That proves the app follows
  the visual viewport, not that iOS reports it the way the emulation does. Chrome on Android is asked to resize the
  page instead (`interactive-widget=resizes-content`, Chrome 108+), which the emulation does not exercise either.
- **The notch is emulated.** `env(safe-area-inset-*)` is 0 in every emulator: the tests set the app's own variables
  (`--safe-top`, `--safe-bottom`, `--safe-inline-start`, `--safe-inline-end`) to a notched phone's values and check
  the header, composer, drawer, thread and notice band keep clear. Whether iOS gives the values expected (portrait in
  Safari: none at the top, the home indicator at the bottom; landscape: the sides) is for a real device.
- **No service worker in the WebKit project.** Once a worker controls the page, Playwright's WebKit stops routing
  the page's requests (the real Turnstile script was fetched), so the `iphone` project blocks workers; the worker is
  tested in Chromium (`pwa.spec.ts`).
- **A message's text cannot be selected on a touch screen.** A long press opens the message's menu instead, which
  has "Copy text" (the whole text). Links and images keep the browser's own long press; part of a message cannot be
  copied on a phone. *Intended fix if it matters:* a "Select text" item that makes the message selectable once.
- **Enter sends, on a phone too.** The keyboard's Enter key says "Send" (`enterkeyhint`); a phone keyboard has no
  Shift+Enter, so a message typed on a phone is one paragraph (pasted line breaks are kept). *Intended fix if the
  family wants it:* Enter as a new line on touch screens, with Send as the only way to send.
- **The page itself never overscrolls vertically** (`overscroll-behavior-y: none` on the page, `contain` on the
  lists, the sidebar and the dialogs): no pull-to-refresh, so a stuck page is reloaded from the browser's menu
  (Safari's reload button, Chrome's ⟳), or by closing and reopening the installed app.
- **Popovers and the keyboard.** The emoji picker and the message menu stay open when only the window's height
  changes (Chrome on Android resizing the page as its keyboard opens or closes): they follow their anchor, and close
  on a change of width (rotation) or once the anchor is out of sight (unit-tested). On iOS, where the keyboard does
  not resize the window, they are placed in the window, not in what the keyboard leaves.
- **On a real iPhone (Safari, then installed from the Home Screen), please check:**
  1. Tap the message field: the page does not zoom in; the keyboard opens and the field and Send sit right on top
     of it, the channel header still visible; type, tap Send, the keyboard can stay open; close it: the app fills the
     screen again, no gap at the bottom.
  2. Open a thread and reply from its field: same as above. Open "New channel" and tap its Name: the dialog and its
     Create button stay above the keyboard.
  3. Long press a message: its menu opens (no text selection, no magnifier); Copy text, then paste it elsewhere.
     Long press a link in a message: Safari's own link menu, not Slax's.
  4. Rotate to landscape: nothing under the notch or the rounded corners; the composer clear of the home indicator
     in both orientations; the channel list (drawer in portrait, sidebar in landscape) reachable.
  5. In Hebrew: the drawer comes from the right, the menu and thread read right to left.
  6. Scroll a long channel to the top and keep pulling: the list stops, the page does not bounce or reload.
  7. Both themes: the status bar and the tapped-message tint look right.
- **On a real Android phone (Chrome, then installed):** items 1 to 7 as above (on item 1 Chrome shrinks the page with
  the keyboard; the composer must end right above it), a long press on a message must open Slax's menu, not
  Chrome's text selection, and, with the keyboard up (the message field focused), open a message's menu and the
  reaction picker: neither may close by itself as the keyboard goes away.

## Push notifications (Web Push)

**Where:** `backend/app/Services/Push/`, `backend/app/Jobs/SendPushNotification.php`,
`backend/app/Http/Controllers/PushSubscriptionController.php`, `backend/lang/*/push.php`, `frontend/src/pwa/push.ts`,
`PushSettings.tsx`, `sw-push.ts`, `e2e/tests/push.spec.ts`; operations in `docs/runbook.md` 4.11.

- **Real delivery was NOT tested.** No automated run reaches Apple, Google (FCM), Mozilla or Microsoft: Pest uses a
  fake sender, the real sender (encryption, VAPID signature, how each answer is treated) is tested against a mocked
  HTTP client, and the e2e stack has no VAPID keys (push off; a second e2e test shows the switch with a stubbed key
  and a stubbed browser push service). Whether a notification actually appears, how it looks, and what a tap does on
  each platform must be tried on the family's real devices: turn notifications on (account menu), press "Send a
  test", then close the app and have someone send a DM, an @mention and a reply in a thread you wrote in; tap each
  notification (it must open that conversation, or that thread); sign out and check nothing arrives any more.
- **iPhone and iPad: iOS 16.4 or later, installed app only.** Safari has no Web Push in a tab: outside the installed
  app the menu explains to add Slax to the Home Screen first. Older iOS shows nothing. Safari on macOS 13+ supports
  push in a tab (the switch shows); Firefox and Chromium browsers everywhere else.
- **Only someone shown "online" is not notified.** The server cannot know whether a tab is visible, so it uses the
  presence state: `online` (a heartbeat in the last 60 s and an interaction with Slax in the last 5 minutes, on any
  device) gets no push; `away` (a tab still open, no interaction for 5 minutes, e.g. a desktop tab in the background)
  and `offline` are notified. So for up to 5 minutes after last touching Slax on one device, the person's other
  devices stay silent too; after closing the app (no heartbeat), pushes resume within a minute at most.
- **What notifies:** a new message in a DM or group conversation; an @mention, in any channel (the first name,
  "@dana", or the whole name without spaces, "@DanaCohen", case ignored: two people sharing a first name are both
  notified); a reply in a thread the person started or replied in. One notification per person per message. Not:
  ordinary room messages, reactions, edits, being added to a channel. Never the author, a banned account, a
  non-member (membership is checked again when the job runs), or anyone online right now. A message deleted before
  its job runs is not pushed.
- **What a notification says:** the sender and the channel ("Dana in #family", "Dana (direct message)", also for a
  group conversation) and a generic line ("New message", "You were mentioned", "New reply") in the language of the
  device (the app's language when it subscribed or last opened). Never the text, an e-mail address or a file name: a
  sender whose name is an e-mail address (a Google account without a name) shows as "Someone".
  The payload is end-to-end encrypted to the browser (RFC 8291); the push service sees the endpoint, the time and the
  size only.
- **Key rotation invalidates every subscription.** A device subscribed with the old public key is deleted at its next
  push instead of being retried, and the app shows the switch off at its next opening: everyone turns notifications
  on again.
- **Dead and failing subscriptions:** a 404 or 410 deletes the device; no answer, 429 or 5xx is tried three more times
  (after 30 s, 2 min, 10 min), then dropped with a warning in the queue's log; any other refusal is dropped at once.
  None of this alerts the administrators, and none of it can fail sending a message. There is no periodic cleanup:
  a device that silently stopped working stays until something is pushed to it; an account keeps ten devices at
  most, an eleventh replaces the one that went longest without a push.
- **Sign-out removes this device** (DELETE, then the browser's unsubscribe once the server answered, three seconds
  at most; offline neither happens: the sign-out fails too and notifications keep working). A ban
  deletes all of the account's devices on the server and unsubscribes the browser. A session that merely **expired**
  (14 days without any request, typically a phone left unused) keeps its notifications: the person
  did not sign out, and losing them at every expiry would make them useless. The cost, on a shared device: until
  someone signs in there again, the previous person's notifications (sender and channel names) keep arriving. The
  browser remembers which account turned them on (`slax.pushOwner`, an account id, in local storage): when another
  person signs in, that subscription is dropped, never taken over.
- **The browser renewing a subscription by itself** (`pushsubscriptionchange`) is not handled in the service worker,
  which cannot authenticate (no CSRF token there): the app sends the current subscription again each time it opens.
- **One queue worker, two queues.** Push jobs go on the `push` queue; the worker (`--queue=default,push`) takes every
  waiting broadcast before the next push, so a burst of notifications never queues ahead of realtime events. A
  broadcast that arrives while a push is being sent still waits for it (5 s at most, the push timeout).
- **Endpoints are restricted to the push services** (FCM, Mozilla, Apple, WNS; https, port 443): the queue worker
  POSTs to them, so a user cannot aim it at an internal address. A new browser vendor's push service would need its
  host added to `config/slax.php`.

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
  account, an administrator's or a member's messages in it included (Ruling P, pinned by `DemoResetTest`); so are a
  channel a demo account created and a thread a demo account started, with the members' messages and replies in
  them. The demo's sample messages get exactly their sample reactions back each night, anyone's others go.
- **A promotion during the 03:00 reset can still lose content.** The reset lists the demo accounts first, then
  deletes files from S3, then the rows: an account made a member while it runs (a few seconds, longer with many
  files) is still treated as demo in that run. Promote people during the day, ideally before they write anything.
- **Family accounts are promoted by hand.** A relative signs up as a demo account like any visitor and becomes a
  `member` when an administrator clicks "Make member" (Administration → Accounts). Until then, what they write is
  demo content: it goes at the next nightly reset on the public showcase. No e-mail allowlist exists (addresses
  stay out of configuration). The accounts list shows the 200 most recently seen accounts, without search.
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

## Legal pages

- **`/privacy` and `/terms` are drafts by the maintainer, not legal advice.** They say what Slax stores and
  does (Google sign-in data, messages and files, push registrations, 14-day sessions, the 03:00 UTC demo reset, 35-day
  backups, 180-day audit log, Cloudflare Turnstile, AWS Frankfurt, Telegram alerts that carry ids and technical
  details, never message text). `frontend/src/legal/legal.test.ts` pins those figures: when one of them changes, the
  text changes in the three languages in the same commit. The Hebrew is a draft to be read by a Hebrew speaker.
  The contact is the maintainer's public GitHub profile; there is no e-mail address and no automated export or
  deletion form (a person asks, the administrator does it by hand).
- **The pages are rendered by the app's script** (like the rest), so a crawler that does not run JavaScript sees the
  empty shell. Google does not need more for the three basic scopes; an app verification would.
