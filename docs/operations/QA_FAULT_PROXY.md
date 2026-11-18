# QA fault proxy (local development tool)

`scripts/qa/faultProxy.mjs` is a reverse proxy that sits between a **development
build** on the simulator and the **staging** (or a local) backend. It can fail,
delay or hold one route at a time, so the findings the de7fcb8 QA audit could
not observe become visible. See the "Proxy / client-side fault injection" row in
`evidence/qa-audit-de7fcb8/VERIFY-REPORT.md`.

It is **not product code**. Nothing in `mobile/`, `lib/` or `src/` imports it,
and no build or deploy runs it.

## Safety (enforced in code, covered by `tests/qa/faultProxy.test.ts`)

- **Target:** a local backend (`localhost`, `127.0.0.1`, `::1`) or the staging
  Cloud Run service over https (`https://[tag---]maybesitter-api-staging-…run.app`).
  The proxy refuses anything else at start-up and exits with a non-zero code.
  That includes production.
- **Listening:** the proxy and its control API both listen on `127.0.0.1` only.
  The control API also rejects any request whose `Host` header is not loopback.
- **Tokens:** the `Authorization` header is never written to the log or to a
  body file. The same goes for cookies, token-like headers, and body fields
  whose names look like secrets (`*token*`, `password`, `secret`, `code`, …).
  Each one reads «مخفي». Any body string that contains the bearer token is
  replaced the same way.
  - The log keeps `authUid`: the `user_id` claim decoded from the token's
    payload. It shows which account sent a request, which the account-switch
    findings need. The token itself is never written.
- **Bodies:** request bodies are written only when you turn this on. They go to
  a new directory under the OS temp dir (`maybesitter-fault-proxy-*`), with
  file mode 600. If you pass a `--body-dir` inside the repository, the proxy
  refuses it. Delete the directory when you are done.

## Run it

```bash
# from a monorepo checkout; no dependencies to install
node scripts/qa/faultProxy.mjs \
  --target https://maybesitter-api-staging-xw5vhndxxq-ew.a.run.app \
  --port 8787 --control-port 8788          # defaults; add --log-bodies to record bodies now
```

On a shared machine, 8787 may already be in use. If the proxy exits with
`EADDRINUSE`, pick free ports and pass the same `--control-port` to
`faultProxyCtl.mjs`. Check a port first with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.

Stop it with Ctrl-C. To confirm nothing is left listening:
`lsof -nP -iTCP:8787 -iTCP:8788 -sTCP:LISTEN` should print nothing.

## Point a development build at it

A development build already accepts `http://localhost:<port>`.
`releaseConfigProblems` (`mobile/src/config/releaseGuard.ts`) returns early for
`APP_ENV=development`. App Transport Security in `mobile/app.config.ts` allows
loads in development (`NSAllowsArbitraryLoads` plus a `localhost` exception).
Staging and production builds still refuse `http` and local hosts. **Do not
change either guard.** Use a development build.

```bash
cd mobile
APP_ENV=development EXPO_PUBLIC_API_BASE_URL=http://localhost:8787 npx expo start --clear
```

- `EXPO_PUBLIC_*` values are inlined when Metro bundles the app. The `--clear`
  flag stops a cached bundle from keeping the old URL.
- **iOS simulator:** it shares the Mac's loopback, so `localhost:8787` works
  as is.
- **Android emulator:** run `adb reverse tcp:8787 tcp:8787` and keep
  `http://localhost:8787`. Alternatively, use `http://10.0.2.2:8787`.
- **Firebase Auth does not go through the proxy.** Sign-in and token refresh
  call `securetoken.googleapis.com` directly, so the app still signs in to the
  real staging project.

## Control it

You can use the command-line tool (`scripts/qa/faultProxyCtl.mjs`, with
`--control-port N` when the port is not 8788) or plain `curl`:

| What | Command line | curl |
|---|---|---|
| fail with a status | `faultProxyCtl.mjs fail GET '^/api/mobile/football$' --status 503` | `curl -s -XPOST 127.0.0.1:8788/rules -d '{"action":"fail","method":"^GET$","path":"^/api/mobile/football$","status":503}'` |
| fail with a body | `… fail PUT '^/api/mobile/football$' --status 409 --body '{"error":"provider_not_configured"}'` | same, with `"body":"…"` |
| cut the connection | `… fail POST '^/api/mobile/recommendations/next-step/actions$' --drop` | `"drop":true` |
| delay (ms) | `… delay '*' '^/api/mobile/commitments/' 4000` | `{"action":"delay","path":"…","ms":4000}` |
| hold until released | `… hold POST '^/api/mobile/habits$'` | `{"action":"hold",…}` |
| hold, then answer a status | `… hold POST '^/api/mobile/habits$' --status 401` | `{"action":"hold",…,"status":401}` |
| once / N times | `--once` / `--times 3` | `"once":true` / `"times":3` |
| list / remove / clear rules | `rules` / `remove r3` / `clear` | `GET /rules` / `DELETE /rules/r3` / `DELETE /rules` |
| held requests / release | `held` / `release [ruleId]` | `GET /held` / `POST /release -d '{"ruleId":"r3"}'` |
| request log | `log` / `log-clear` | `GET /log` / `DELETE /log` |
| record bodies | `bodies on` / `bodies off` | `POST /bodies -d '{"enabled":true}'` (the answer names the directory) |

How the rules behave:

- `method` and `path` are regular expressions. The command line turns `GET`
  into `^GET$` and `*` into `.*`.
- `path` is matched against the path without its query string. The log shows
  the path with its query string.
- The first matching rule that still has uses left applies. A rule with no
  `once` or `times` applies every time.
- `fail` answers at once. The default status is 503. The request never reaches
  the target.
- `delay` waits, then forwards the request.
- `hold` without a status forwards the request now and holds the real answer
  until it is released.
- `hold` with a status never forwards the request. On release it answers that
  status (for example, a late 401).

Each log entry has `time`, `method`, `path`, `status`, `durationMs`, `action`,
`ruleId`, `outcome` (`forwarded`, `injected`, `dropped`, `held`, `released`,
`upstream_error`) and `authUid`.

## Recipes for the audit findings

Run `clear` and `log-clear` before each recipe. "Expected" means what the
finding predicts. If you see the predicted behaviour, the finding is
**confirmed**. If the app behaves correctly, it is **not reproduced**.

| Finding(s) | Rule | Expected |
|---|---|---|
| **CA1.11, CXA1.1** (S1) | `hold PUT '^/api/mobile/consents/recommendations$' --status 401`. Answer the recommendations question as A. While it is held, sign out and sign in as B, then `release`. Do the same with `hold POST '^/api/mobile/analytics$' --status 401`. | `log` shows a second request to the same route with `authUid` = B, carrying A's answer or event. B's recommendation consent changes. |
| **CXX3.2** (S1) | `hold POST '^/api/mobile/(habits\|weekly-blocks)$' --status 401`. Create a habit or weekly block as A, switch to B, then `release`. Variant: `--status 403 --body '{"error":"revoked"}'`. | The retry runs as `authUid` = B, and the item appears in B's account. With 403 `revoked`, B is signed out. |
| **CXA13.2** (S1, partial) | `hold POST '^/api/mobile/readiness$' --status 401`. Refresh Health readiness as A, switch to B, then `release`. | The retried POST carries A's summary as `authUid` = B. The proxy cannot slow the HealthKit read itself; the device half needs an injected delay in a dev build. |
| **CXA1.6** (S2) | Out of proxy reach: `AsyncStorage.removeItem` has to fail. Needs a dev build with a failing storage module. | A's `onboarding.v1=done` survives sign-out, and B skips onboarding. |
| **CA1.3** (S3) | `bodies on`, no rule. In setup chat, paste a narrative of 600 emoji, then answer the day question. | The `POST /api/mobile/profile/describe` body file has text cut short of the 600 emoji, and the day line is missing. |
| **CA2.8, CXA2.8** (S3) | `fail POST '^/api/mobile/commitments/[^/]+/actions$' --status 500` (and `--drop`). On Today, mark an item done, swipe it, and tap «خلصتها». In Details, do complete, start, category, then drop/delete. | No error toast and no message; the row stays. |
| **CXA2.7** (S3) | `bodies on`. `fail POST '^/api/mobile/recommendations/next-step/actions$' --drop --once`, then tap the same next-step decision again. | The two body files have different `idempotencyKey` body fields. The second tap can bring a stale 409 or a second decision. |
| **CA3.4, CXA3.5** (S3) | `bodies on`, then confirm a capture once with no rule to see the receipt shape. Next: `fail POST '^/api/mobile/capture/confirm$' --status 200 --body '<receipt with one failed[] item>'`, built from that shape with a real proposal id. | The saved screen lists «في إشي ما انحفظ» with an item id (UUID) instead of the title. |
| **CXA4.1** (S3) | `fail POST '^/api/mobile/plans/[^/]+/actions$' --status 500` (and `--drop`). Accept, then dismiss a plan. | The control stops loading, and no failure message appears. |
| **CXA6.5** (S3) | `fail GET '^/api/mobile/held-items$' --status 500` on an account with held items and `externalClashHold` on. Open Watching. | The held card vanishes with no error or retry; the screen looks the same as with zero holds. |
| **CXA6.8, CXA7.5** (S3) | `fail GET '^/api/mobile/intelligence/sources/gmail/monitor$' --status 500` (the inbox GET still works). Open the intelligence panel. | It shows "turn monitoring on" with a disabled switch, and no error. |
| **CXA8.8** (S3) | Out of proxy reach: the clipboard write has to fail. Needs a dev build with a failing `expo-clipboard`. | The handoff to the assistant goes ahead with no prompt and no notice. |
| **CXA8.11** (S3) | First `fail GET '^/api/mobile/pilot/trust$' --status 500`, then (after `clear`) `fail GET '^/api/mobile/profile$' --status 500`. Open «بيعرف». | A trust failure hides memory, AI import and the privacy rows. A profile failure shows the normal "no previous import" subtitle. |
| **CXA8.1** (S3) | `fail GET '^/api/mobile/memory$' --status 500` (and `--drop`) before Knows first loads. | The memory section is gone, with no error or retry. |
| **CA11.3, CXA11.1** (S3) | `fail GET '^/api/mobile/football$' --status 503`. Open football settings (from Sources or the Watching held card). | An empty club card and the attribution appear, with no error or retry. |
| **C12.6, CXA12.6** (S3) | `fail POST '^/api/mobile/pilot/trust$' --status 500` (and `--drop`). Revoke trust and confirm. | The dialog closes with no failure message and trust is unchanged, yet Clarity consent is already off on the phone. |
| **C12.8** (S3) | `fail GET '^/api/mobile/settings/categories$' --status 500`. Open category settings. | The spinner never stops, and there is no error or retry. |
| **CXA12.3** (S3) | `fail GET '^/api/mobile/settings/(reminders\|plan)$' --status 500` (one at a time too). Open notification settings fresh. | Switches look off or at defaults, with no "unavailable" message. |
| **CXA12.5** (S3) | `fail GET '^/api/mobile/(pilot/trust\|consents)$' --status 500`. Open Trust fresh. | Every option looks off and disabled, with no error or retry. |
| **CXA13.9** (S3) | `fail GET '^/api/mobile/commitments/upcoming$' --status 500` on a cold start (then the inverse, with `today`). Use an account with a place reminder on Today. | The Today place reminder is not armed; a removed one is not cleared. Check with the place-reminder debug or region list. |
| **CX3.6** (S3) | Out of proxy reach: the token refresh goes to `securetoken.googleapis.com`, not through the proxy. Block that host (for example `/etc/hosts` on the Mac while the simulator runs), wait more than an hour or force a refresh, then open any screen. Only `fail … --status 401` through the proxy is not enough. | The app shows «سجّل دخولك من جديد» instead of a network error. |
| **CA3.8** (S4) | `delay GET '^/api/mobile/(commitments\|recommendations)/' 6000`. Confirm a capture, then watch the saved screen. | The ring reaches 0 while `saved-undo` still works until the refetch ends. |
| **CA11.6** (S4) | `fail PUT '^/api/mobile/football$' --status 409 --body '{"error":"provider_not_configured"}'`. Repeat with 400, with 404, and with 503 `{"error":"follow_not_saved"}`. Save a club. | Every case shows «…تأكد من الاتصال واضغط كمان مرّة». |
| **C12.10** (S4) | `fail PUT '^/api/mobile/settings/reminders$' --status 500` (and `--drop`). Toggle gentle reminders. | Two failure lines: `notifications-save-failed` and «هاد ما انحفظ. ما تغيّر إشي.» |

That is the 24 finding groups in the row; the row's own count is 24. Three of
them (CXA1.6, CXA8.8, CX3.6) need a dev-build module fault or a blocked Google
host rather than this proxy, and CXA13.2 needs both for the full picture. Some
findings may have been fixed since de7fcb8; check
`evidence/qa-audit-de7fcb8/FIX-TRACKER.md` before you record a verdict.
