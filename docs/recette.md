# Slax v1 acceptance (recette)

The acceptance criteria of the design (docs/superpowers/specs/2026-10-30-slax-design.md, §10
"Comment on saura que c'est fini") turned into steps to run by hand, first on **dev**
(`https://dev.slax.yechpa.com`, on the tailnet), then on **prod** (`https://slax.yechpa.com`).
Run them in order: each part assumes the previous ones passed.

**Status: nothing in this document has been run yet** on dev or prod (it was written before
either environment existed). The local suites it refers to were run when it was written: see
the "Automated" column and the commands in part 1.

Legend: **A** automated and run by CI on every pull request (the job named), **A (local)**
automated but run by hand on a workstation (`make …`, not in CI), **M** manual on the real
environment, **A+M** automated on the local e2e stack in CI (fake Google, MinIO) and to be
seen once by hand on the real one (real Google, real S3, Caddy, k3s).

What you need: the dev cluster bootstrapped (deploy/dev/BOOTSTRAP.md §1-10) and production
set up (docs/runbook.md §3) with the Telegram keys in both `slax-secrets`; your own Google
account listed in `ADMIN_EMAILS` (account **A**, administrator); a second Google account
(**B**, a visitor); two browsers (or one normal and one private window) and a phone.

Record each run here (copy the table per environment):

| Environment | Commit / tag | Date | By | Result |
|---|---|---|---|---|
| dev | | | | |
| prod | | | | |

## 1. Automated baseline (before anything by hand)

| # | Check | How | |
|---|---|---|---|
| 1.1 | CI green on the commit: `lint`, `test`, `e2e` (Playwright, 15 tests, then the 10-second load smoke), `chart`, `secrets` (gitleaks), Images (6 builds, 4 manifests, Trivy) | GitHub → Actions, or `gh run list --branch main --limit 5` | A |
| 1.2 | The deployment pieces' own tests (`make chart-lint` also runs in CI, job `chart`; the others do not) | `make chart-lint backup-test monitor-test proxy-test aws-test edge-guard-test` | A (local) |
| 1.3 | The load test: 50 WebSocket clients, 10 messages/s for 2 min, 0 lost, 0 duplicated, 0 HTTP error (CI runs only the 10-second smoke at the end of `e2e`) | `make load` → docs/load-test-results.md (a run is committed) | A (local) |
| 1.4 | No secret in the repository or its history | CI `secrets`; GitHub → Security → Secret scanning: no open alert | A+M |

## 2. Delivery: merge → dev, tag → prod with approval, rollback

Spec: "Une modification fusionnée arrive en dev sans intervention ; une version étiquetée
arrive en prod après validation ; un retour arrière est démontré."

2.1 [ ] **Merge → dev, untouched (M).** Open a trivial pull request (a comment), merge it.
Without doing anything else: Actions → *Images* green, then *Deploy dev* starts by itself
and is green; Telegram `[Dev] Deploy OK: <short sha> is live on dev.`;
`helm -n slax history slax` on dev shows that sha. (BOOTSTRAP.md §11 items 2-7 in detail.)

2.2 [ ] **Tag → prod after approval (M).** On a `main` commit that dev runs well:
`git tag -a vX.Y.Z -m "Slax X.Y.Z" origin/main && git push origin vX.Y.Z` (you, never a
script). Actions → *Release prod*: `check` green, `deploy` **waits** for "Review
deployments"; nothing reaches production before you approve. Approve: Telegram
`[Prod] Release vX.Y.Z (…) is live on slax.yechpa.com.` (runbook §3.11.)

2.3 [ ] **Rollback by hand (M).** In one terminal, a loop on the site
(`while sleep 1; do curl -s -o /dev/null -w '%{http_code}\n' https://slax.yechpa.com/api/v1/health; done`);
in another, `helm -n slax history slax` then `helm -n slax rollback slax <previous> --wait`.
The loop keeps printing `200`; `history` shows `Rollback to N`; the version shown by
`kubectl -n slax get deploy slax-app -o jsonpath='{..image}'` is the previous sha. Roll
forward again the same way. (Runbook §4.2.)

2.4 [ ] **Failed deployments roll themselves back (M).** Runbook §7 item 9 (a web
container that cannot start: Helm's `--atomic`) and item 10 (a release whose post-deploy
checks fail: the workflow's own `helm rollback`, Telegram `ROLLED BACK`).

2.5 [ ] **v1.0.0.** Only when every other line of this document is ticked on prod: tag the
release commit `v1.0.0` exactly as in 2.2. (A `v*` tag starts the production release: it
is yours to push.)

## 3. The full journey, 3 languages × 2 themes

Spec: "Un parcours complet fonctionne sans erreur … dans les trois langues et les deux
thèmes : connexion Google, rejoindre un canal, écrire, répondre en fil, réagir, envoyer un
fichier, envoyer un message privé, voir la présence."

**A**: `e2e/tests/journey.spec.ts` runs this whole journey in the 6 combinations, with a
second browser watching what must be live (`e2e/tests/realtime.spec.ts`: live messages and
reactions, a network cut without loss or duplicate, a retried send stored once, a removed
member cut off, typing, presence).

**M** on prod (then dev), as account B in browser 1 and account A in browser 2. Switch
language (the language menu) and theme (one click) between rounds; each round takes a few
minutes:

| Step | en · Console | en · Listing | he · Console | he · Listing | fr · Console | fr · Listing |
|---|---|---|---|---|---|---|
| Sign in with Google (the real consent screen; Turnstile passes unseen or with one click) | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Land in `#general`, then join another channel (Browse channels) | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Write a message: it appears at once in browser 2 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Reply in a thread; browser 2 sees the reply count | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| React; browser 2 sees the reaction | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Send a file by drag and drop: an image (preview), a PDF (opens), a `.txt` (downloads) | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Send a direct message to A; A sees it and B's presence (online, then away after inactivity) | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| "A is typing…" shows while A types | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Edit, then delete your own message | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| DevTools → Console: no error, no CSP violation; Network → WS `/app/…` connected | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

Also once: the phone (a narrow screen: the menu, the thread as a full page) in one
language and theme, and a reload in the middle of a conversation (nothing lost).

## 4. Hebrew, right to left, with English words

Spec: "L'hébreu s'affiche correctement de droite à gauche, y compris avec des mots anglais
dans une phrase."

**A**: `e2e/tests/rtl.spec.ts` checks the geometry in Hebrew against English (sidebar on
the right, the thread on the left, arrows and keys mirrored, nothing off the edge, `#name`
kept whole), on a channel with an English topic, an English message and a Hebrew reply;
reference screenshots in docs/design/e2e/.

**M** on prod, interface in Hebrew:

4.1 [ ] Post `אני מעלה את הגרסה ל-Kubernetes עם k3s היום` and `Ship it when CI is green, ואז נבדוק`:
each reads in the right order, the English words stay readable, the punctuation sits at the
right end.
4.2 [ ] A message mentioning `@` a Latin-named user and a `#channel` inside Hebrew text: the
sigils stay attached to their names.
4.3 [ ] A file with a Hebrew name (`דוח-אוקטובר.pdf`): the chip shows the name whole; the
download keeps it.
4.4 [ ] Dates and times ("yesterday", "today", hours) and the reply counts read naturally
in Hebrew. (Messages are plain text: v1 has no code blocks to keep left to right.)
4.5 [ ] Hebrew text in the Listing theme, on the phone: same.
4.6 [ ] You (yechpa) have read every Hebrew string once (design spec: the translations are
reviewed by you): `frontend/src/i18n/he.json`.

## 5. Files on real S3, and hostile files

5.1 [ ] **Before the first release:** the S3 probe in a one-off pod (runbook §7 item 7) →
`PASS: put, get and delete …`. **M**
5.2 [ ] An image's preview loads from `https://slax-files-<suffix>.s3.eu-central-1.amazonaws.com/…`
(DevTools → Network), not from slax.yechpa.com; the `.txt` downloads as an attachment
(`Content-Disposition: attachment`). **A+M**
5.3 [ ] A Windows executable renamed `notes.txt` is refused, with an explanation; nothing
is stored. **A** (journey.spec.ts) **+M**
5.4 [ ] An 11 MB file is refused as too large (10 MB per file). **M**
5.5 [ ] As admin, Administration → Status: `s3 ok`. **M**

## 6. Security headers and the edge

6.1 [ ] `curl -sI https://slax.yechpa.com/` → `HTTP/2 200` and:

```text
strict-transport-security: max-age=31536000; includeSubDomains
content-security-policy: default-src 'self'; … img-src 'self' … https://slax-files-<suffix>.s3.eu-central-1.amazonaws.com …; frame-ancestors 'none' …
x-content-type-options: nosniff
referrer-policy: …
permissions-policy: …
```

6.2 [ ] `curl -sI http://slax.yechpa.com/` → `308` to `https://`.
6.3 [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://slax.yechpa.com/apps/x/events` → `404`
(Reverb's API is not public).
6.4 [ ] The certificate: `echo | openssl s_client -connect slax.yechpa.com:443 -servername slax.yechpa.com 2>/dev/null | openssl x509 -noout -issuer -dates`
→ Let's Encrypt, about 90 days.
6.5 [ ] Ports: from outside the tailnet, `nc -vz -w 5 slax.yechpa.com 22` and `… 6443` time
out (runbook §7 item 6).
6.6 [ ] Optional, external views: securityheaders.com and SSL Labs on `slax.yechpa.com`
(A or better expected; note anything they flag).

(`make proxy-test` and `make web-check` check the same headers locally: **A**.)

## 7. Administration and moderation

7.1 [ ] As A: Administration → Status lists `database`, `redis`, `reverb`, `scanner`, `s3`,
all `ok` with their latency. **A** (AdminTest) **+M**
7.2 [ ] Administration → Audit shows your sign-in with **your public IP** (not 10.42.x.x, not
the Elastic IP; runbook §7 item 5). **M**
7.3 [ ] **Ban flow.** B is signed in (browser 1, a channel open). As A, Administration → B →
Ban: within seconds B's live updates stop and B's next action sends B back to the sign-in
page with the "banned" explanation; signing in again with B's Google account is refused;
the audit log shows the ban. Unban (the "Banned" list): B can sign in again. **A** (Pest)
**+M**
7.4 [ ] As A, delete one of B's messages (it disappears for everyone, live) and lock a
channel (B's composer is replaced within a minute; a post is refused with an explanation).
**M**
7.5 [ ] B cannot open Administration (no menu entry; `/admin` refused). **A+M**

## 8. Demo reset (prod only)

The showcase resets every night at 03:00 Asia/Jerusalem (runbook §4.7): demo accounts'
content goes, accounts inactive for 7 days go (active and banned ones stay), the starter
channels and seed messages come back.

8.1 [ ] Before 03:00: as B, post in `#general` and create a channel `recette-reset`.
8.2 [ ] After 03:00: the message and the channel are gone, the seed messages are back, B can
still sign in (active account) and lands in `#general`; Audit shows the reset.
8.3 [ ] Your administrator's account and content are untouched.
8.4 [ ] Dev does not reset (`SLAX_DEMO_RESET_ENABLED=false`): content posted there the day
before is still there.

## 9. Backups and restore

9.1 [ ] Runbook §7 item 11: a backup by hand lands under `pg/<today>/` in the backups bucket;
a restore check by hand says `[Prod] Weekly restore check OK: … N users, M migrations`.
9.2 [ ] `kubectl -n slax exec deploy/slax-scheduler -- php artisan backups:check-freshness` →
"The newest backup is N hours old".
9.3 [ ] The next Sunday, the scheduled restore check reports by itself (runbook §7 item 12).
(**A**: `make backup-test` covers the scripts against PostgreSQL, MinIO and a fake Telegram.)

## 10. Alerts reach Telegram, labelled `[Dev]` and `[Prod]`

Every message starts with its environment's label and never carries a user's message,
a secret or an address.

| # | Alert | How to trigger it safely | Dev | Prod |
|---|---|---|---|---|
| 10.1 | Deploy / release | 2.1 and 2.2 | [ ] | [ ] |
| 10.2 | Failed deployment | BOOTSTRAP.md §11 item 13 (dev); runbook §7 item 10 (prod) | [ ] | [ ] |
| 10.3 | An application error | `kubectl -n slax exec deploy/slax-app -c php -- php artisan tinker --execute 'logger()->error("recette check");'` | [ ] | [ ] |
| 10.4 | Uptime: `DOWN` then `RECOVERED` | `kubectl -n slax scale deploy slax-reverb --replicas=0`; after 3-4 minutes one `DOWN: reverb failed 3 checks in a row`; `--replicas=1`: one `RECOVERED: reverb` within 2 minutes; nothing else. The site keeps working (only live updates pause). Never stop PostgreSQL for this. | [ ] | [ ] |
| 10.5 | Uptime: the public URL (prod) | the monitor's log says `public=ok` (runbook §7 item 16). Optional, dev only: `kubectl -n slax scale deploy slax-app --replicas=0` for 4 minutes gives `DOWN: app` | – | [ ] |
| 10.6 | Disk above 80 %, then all clear | lower the threshold for one run instead of filling a disk: `kubectl -n slax set env cronjob/slax-monitor MONITOR_DISK_ALERT_PERCENT=1 MONITOR_DISK_RECOVER_PERCENT=0`; within a minute `DISK: node disk NN% full (alert above 1%)…`; then `kubectl -n slax set env cronjob/slax-monitor MONITOR_DISK_ALERT_PERCENT=80 MONITOR_DISK_RECOVER_PERCENT=75` → within a minute `DISK OK: node disk back to NN% (below 75%)` (a release would also restore the chart's values) | [ ] | [ ] |
| 10.7 | Weekly restore check | 9.1 | – | [ ] |
| 10.8 | Moderation / security events | the ban in 7.3 | [ ] | [ ] |

(**A**: `make monitor-test` proves the uptime logic, the thresholds, the anti-flood and the
absence of secrets in messages; `make backup-test` the backup alerts; Pest the app's
`AdminNotifier` grouping and redaction.)

## 11. Google sign-in, the real one

11.1 [ ] The consent screen names Slax, asks only for name, e-mail and picture (`openid email
profile`), and is "In production" (any Google account can sign in, not only test users).
11.2 [ ] Sign out, sign in again: same account, same content. A second device signs in to
the same account; signing out on one does not sign out the other.
11.3 [ ] Cancel on Google's screen: back on Slax with a clear message, no error page.
11.4 [ ] Dev and prod each use their own redirect URI (`/auth/google/callback` on their host).

## 12. Accessibility and performance (suggestions; nothing here is automated)

12.1 [ ] Chrome DevTools → Lighthouse, desktop and mobile, on the sign-in page and on a
channel (signed in): note Performance, Accessibility, Best practices; target ≥ 90 each, and
look at every Accessibility finding.
12.2 [ ] The axe DevTools browser extension on the same pages in both themes and in Hebrew:
no critical or serious finding (contrast in the Listing theme, labels of icon buttons).
12.3 [ ] Keyboard only: sign in, open a channel, send, open a thread, react, close it.
12.4 [ ] `prefers-reduced-motion` (OS setting): no blinking cursor or animated transitions.

## 13. Documentation

Spec: "Une documentation d'architecture et d'exploitation accompagne le dépôt."

13.1 [ ] README.md (overview, screenshots of both themes, quick start, links) reads well on
GitHub; docs/architecture.md's diagrams render on GitHub.
13.2 [ ] docs/runbook.md's first-time setup (§3) matched what you did; correct anything that
did not.
13.3 [ ] docs/known-limitations.md has nothing you now consider a bug in the v1 scope.

## Sign-off

| Part | Dev | Prod |
|---|---|---|
| 1. Automated baseline | | |
| 2. Delivery and rollback | | |
| 3. Journey × 6 | | |
| 4. Hebrew and bidi | | |
| 5. Files | | |
| 6. Headers and edge | | |
| 7. Administration | | |
| 8. Demo reset | – | |
| 9. Backups | – | |
| 10. Alerts | | |
| 11. Google sign-in | | |
| 12. Accessibility, performance | | |
| 13. Documentation | | |

Then 2.5: tag `v1.0.0`.
