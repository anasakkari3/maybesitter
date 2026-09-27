# Football match data — owner checklist (closure CL7)

Football in «تابعلي هذا الإشي» is built up to the provider key. With no key the
server reports `providerConfigured: false` and the app hides every football
entry point: the watcher source, and Settings → Sources → Football. Nothing is
labelled «قريبًا». This page covers the one owner step that turns it on, and
nothing else. Every value below is one the code reads today.

## What the code talks to

| | |
|---|---|
| Provider | football-data.org, REST API v4 (`lib/football/footballDataProvider.ts`) |
| Request | `GET https://api.football-data.org/v4/teams/{teamId}/matches?dateFrom=…&dateTo=…` |
| Auth header | `X-Auth-Token: <key>` |
| Env variable the server reads | `FOOTBALL_DATA_API_KEY` (a blank or whitespace-only value counts as not set) |
| Clubs | the 15 curated clubs in `data/footballClubs.json`. Their competition codes are `PD`, `PL`, `BL1`, `SA` and `FL1`. |
| Window | the next 60 days (`PROJECTION_WINDOW_DAYS`) |
| Attribution | Settings → Football shows «بيانات المباريات من football-data.org» (`footballAttribution`) |

## Request budget the code assumes

The code assumes the free tier allows **10 requests a minute**
(`REQUEST_SPACING_MS = 6_000` in `lib/football/syncFixtures.ts`). Check this at
signup, and check that the free tier covers the five competitions above.

- **The per-minute poll** runs inside the watcher cron (`watcher-sweep-*`,
  every minute, `/api/internal/jobs/watchers`). It makes at most **1 request a
  minute** (`FOOTBALL_POLL_MAX_FETCHES`), and only for a followed club that is
  due. A club is due when it has never been fetched, when its last good fetch
  is **6 hours** old (`FOOTBALL_POLL_INTERVAL_MS`), or **10 minutes** after a
  failed fetch (`FOOTBALL_RETRY_AFTER_MS`).
- **The nightly sync** (`football-sync-daily-*`, 01:00 Asia/Jerusalem) fetches
  followed clubs 6 s apart inside a 45 s budget, so about 6 requests.
- **Worst case:** about 4 requests a day for each followed club, plus the
  nightly run. Even while both run at 01:00 the total stays under 10 a minute.
- **A 429 (quota) or any other failure** is stored as `rate_limited` or
  `unavailable` on the club's sync state. The watcher row then says
  «مش قادرين نوصل لبيانات المباريات — عم نجرّب كمان مرة», and the matches
  already on the calendar stay there.

## Owner steps (only the owner can do these)

1. Sign up for a football-data.org API key on the **free tier**. If only a
   paid tier covers these competitions, stop and decide on the price first:
   no paid signup without an explicit yes.
2. Put the key in Secret Manager (project `maybesitter-app`), following
   `docs/operations/DEPLOY.md` → "Adding a secret". Suggested secret name:
   `football-data-api-key`. Grant `roles/secretmanager.secretAccessor` on
   that one secret to `maybesitter-run@maybesitter-app.iam.gserviceaccount.com`.
   **Never paste the key into chat.**
3. Add this flag to the `--set-secrets` list in `infra/cloudrun/flags.sh`:
   `FOOTBALL_DATA_API_KEY=football-data-api-key:latest`. This must happen
   **after** step 2 and in its own small PR. A `--set-secrets` entry that
   names a secret that does not exist yet fails the whole deploy, which is
   why it is not in this PR.
4. Deploy staging as usual (a merge to `main` deploys staging).
   Production also needs `infra/scheduler.sh` run for it. Production has no
   scheduler jobs today, so nothing would ever poll there.

## Smoke test after setup (staging)

1. `GET /api/mobile/football` with a signed-in token answers
   `"providerConfigured": true`.
2. In the app, open Settings → Background activity → «تابعلي هالإشي». The
   source list now shows «كرة القدم». Search for «برش», pick برشلونة, and
   confirm with «تابِع».
3. Within about 2 minutes (one or two watcher-cron ticks), the watcher row
   shows a "Last checked" time. Barcelona's matches for the next 60 days
   show in Settings → Sources → Football and on the calendar, 2 hours each.
4. In the Cloud Run logs for `/api/internal/jobs/watchers`, the response
   includes `"football":{"enabled":true,"poll":{…"refreshed":["barcelona"]…}}`.
5. Tap «وقّف المتابعة» on the watcher row. The row disappears, and the
   upcoming Barcelona matches come off the calendar.

## Not covered here

Flights and parcels are **removed** from the app, not marked as coming soon.
They stay removed until the owner chooses a provider for each and approves
its price (council verdict, `evidence/closure-20260926/council/verdict.md`,
item 7).
