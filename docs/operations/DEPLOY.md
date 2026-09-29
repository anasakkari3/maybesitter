# Deploying the backend

Issue: UC-1.0d (#143). Bootstrap and identities come from UC-1.0a (#140).

> **Status (2026-09-25):** merges to `main` deploy staging through keyless
> Workload Identity Federation. Production remains an explicit manual dispatch
> through the protected `production` environment and requires the owner's
> review. Do not infer production readiness from a successful staging run.

## Environments

| | Service | Firestore database | Traffic |
|---|---|---|---|
| Staging | `maybesitter-api-staging` | `staging` | every merge to `main`, or manual dispatch |
| Production | `maybesitter-api` | `(default)` | manual dispatch, GitHub environment `production` requires the owner's approval |

Both run in `europe-west1`. Firebase Auth is shared between them, so **staging
is for test accounts only**.

## How a deploy works

1. GitHub Actions authenticates through Workload Identity Federation. There is
   no service-account key anywhere: the pool is pinned to this repository on
   `refs/heads/main`.
2. **Staging** builds the image from the repository `Dockerfile` and pushes it
   to Artifact Registry as `…/maybesitter/api:<sha>`.
3. It deploys **without traffic**, behind the revision tag `sha-<short>`.
4. The tagged revision is probed: `/api/health/ready` must return `ready:true`,
   and `/api/health` must report the same commit that was built.
5. Only then does traffic move to the new revision.
6. Firestore rules and indexes are deployed from `firestore.rules` and
   `firestore.indexes.json`.

**Production never builds.** A rebuild from the same commit is not guaranteed
to reproduce the same image digest — Docker layer timestamps and base-image
resolution are not pinned bit-for-bit — so "rebuild on promote" could silently
deploy bytes staging never ran or smoke-tested. Instead, a production run:

- resolves the digest of `…/maybesitter/api:<sha>` — the tag the staging
  deploy of this exact commit already pushed — and fails with a clear message
  if no such tag exists ("deploy staging for this commit first");
- checks that staging's service is **currently serving** that digest at 100%
  traffic (not merely that the tag was pushed once — a staging deploy can push
  an image and then fail its own smoke test, or be superseded by a later push
  before the production run starts) and fails the same way if it is not;
- deploys that exact, already-tested digest, unchanged.

So a production dispatch always deploys the bytes staging is currently
running for that commit — never a fresh build, and never an untested digest.

## Rollback

```bash
gcloud run revisions list --service maybesitter-api --region europe-west1
gcloud run services update-traffic maybesitter-api \
  --region europe-west1 --to-revisions=<revision>=100
```

Traffic moves immediately; no rebuild is involved.

A rollback needs the old digest to still exist. `infra/artifact-cleanup.json`
deletes versions older than 30 days outside the newest 10, so every production
run first tags the digest it promotes `prod-<sha>`, and the policy's Keep rule
spares `prod-*`. The policy file only takes effect when applied:

```bash
gcloud artifacts repositories set-cleanup-policies maybesitter \
  --location europe-west1 --project maybesitter-app \
  --policy infra/artifact-cleanup.json --no-dry-run
```

## Service settings

They live in `infra/cloudrun/flags.sh` so the workflow and a manual deploy
cannot drift:

- `--service-account=maybesitter-run@…`, `--allow-unauthenticated` — the app
  authenticates every request itself (UC-1.0e #144), so Cloud Run's IAM check
  would only duplicate it.
- `--port=8080 --cpu=1 --memory=1Gi --execution-environment=gen2 --cpu-boost
  --timeout=60`
- `--concurrency=40 --min-instances=0 --max-instances=3` (staging: 2). Min 0
  keeps the bill near zero; max doubles as a cost circuit-breaker.
- `--startup-probe=httpGet.path=/api/health/ready,periodSeconds=5,failureThreshold=6`
- Secrets only through `--set-secrets`, never plain env.
- The hosted model (`MAYBESITTER_LLM_PROVIDER=gemini`) and the memory module
  (`MAYBESITTER_FEATURE_MEMORY=true`) are on in both environments (production:
  owner spend decision, branch `closure/prod-ai-on`). Both kill switches,
  `MAYBESITTER_AI_DISABLED` and `MAYBESITTER_KILL_SWITCH_MEMORY`, are set to
  `false` rather than left unset, so turning either off in an incident is a
  one-value change on the service. Production's global cap,
  `MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP`, is 500 calls/day (staging 3000).
  Worst case at that cap is about $4–8/day (~$120–240/month): 20,000-character
  inputs, 2,048-token outputs and one billed retry per call. Owner prerequisites
  before production: a production-scoped AI alert (the existing "Vertex AI
  requests above 1500/day" alert counts the whole project, which staging alone can
  exceed) and a `MAYBESITTER_LLM_UID_SALT` secret (unset, model logs carry an
  unsalted hash of each uid). About 8 heavy users exhaust 500/day, after which
  everyone falls back to the rule-based path until UTC midnight.
- `MAYBESITTER_KMS_KEY_NAME` (the `user-secrets` key) on both services. It
  seals Google refresh tokens and ICS feed URLs; without it Google connect
  answers `not_configured`. It used to be set on staging by hand only.
- `ICS_FEEDS_ENABLED` (calendar links, UC-3.4 #188): `true` on staging,
  `false` written explicitly on production. It gates
  `/api/mobile/calendar/ics/**` and the `ics-feed-refresh` job; unset, every
  call answers 404 `feature_disabled` and the app has nothing to offer
  (owner's phone, 2026-09-29). Feed URLs are sealed with
  `MAYBESITTER_KMS_KEY_NAME`, so no other variable is needed. Production is
  switched on by changing that one value in `flags.sh` after staging has
  evidence — an owner decision, like the football credential below.
- `MAYBESITTER_SITE_ORIGINS` on production only: `https://maybesitter.com`,
  `https://maybesitter-app.web.app`, `https://maybesitter-app.firebaseapp.com`,
  the exact origins the early-access form may post from. `www` redirects to
  the apex at Hosting, so it is not listed.
- The env list is passed as `--update-env-vars=^;^A=1;B=2;…` (gcloud's custom
  delimiter, `gcloud topic escaping`), because `MAYBESITTER_SITE_ORIGINS` is
  itself comma-separated. Add a variable with `;`, never `,`.

## Adding a secret

```bash
gcloud secrets create <name> --replication-policy=user-managed --locations=europe-west1
printf '%s' "<value>" | gcloud secrets versions add <name> --data-file=-
gcloud secrets add-iam-policy-binding <name> \
  --member=serviceAccount:maybesitter-run@maybesitter-app.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

Then add it to `infra/cloudrun/flags.sh` as `--set-secrets NAME=<name>:latest`.
Grant the accessor role on that one secret, never project-wide.

`FOOTBALL_DATA_API_KEY` is intentionally mapped only for staging from
`maybesitter-football-data-api-key`. A production deploy must not add that
mapping until the owner separately approves production football sync after a
successful staging run.

## Scheduled work

There is no worker process beside the server. Cloud Run throttles CPU on idle
instances and scales to zero, so an in-process `setInterval` would not run
reliably, and a worker process beside the server would have to be kept alive
and paid for. Cloud Scheduler calls the service instead, and each call carries
an OIDC token the route verifies (`lib/auth/schedulerOidc`): Google's
signature, `aud` pinned to the service's own URL, and the caller's email.

| Job | Schedule | Endpoint |
|---|---|---|
| `jobs-tick-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/run` |
| `daily-plan-tick-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/daily-plan` |
| `hard-reminders-tick-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/hard-reminders` |
| `watcher-sweep-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/watchers` |
| `replan-tick-{staging,prod}` | `*/5 * * * *` UTC | `/api/internal/jobs/replan` |
| `ics-feed-refresh-{staging,prod}` | `*/30 * * * *` UTC | `/api/internal/calendar/ics/refresh` |
| `football-sync-daily-{staging,prod}` | `0 1 * * *` Asia/Jerusalem | `/api/internal/jobs/football-sync` |
| `maintenance-daily-{staging,prod}` | `17 3 * * *` Asia/Jerusalem | `/api/internal/jobs/maintenance` |

`infra/scheduler.sh <staging|production>` creates all eight jobs idempotently, and
sets the two variables the routes need:

| Variable | Value | Why it is set there and not in `flags.sh` |
|---|---|---|
| `MAYBESITTER_SCHEDULER_SA_EMAIL` | `maybesitter-scheduler@<project>.iam.gserviceaccount.com` | the only caller these routes accept |
| `MAYBESITTER_INTERNAL_AUDIENCE` | the service's own URL | Cloud Run only assigns the URL at the first deploy, so it cannot be a static flag — and the URL embeds the project number, which is not committed |

Every job has a 60-second attempt deadline. The frequent sweeps have zero
immediate retries because the next scheduled sweep is the retry and overlapping
retries can skip that next cadence. The two daily jobs retry up to three times
inside 15 minutes, with 30–300 second backoff, because otherwise one transient
5xx would defer the work for a full day.

Before applying anything, the read-only check verifies the Cloud Run identity
variables plus every job's enabled state, schedule, target, method, OIDC caller,
audience, deadline and retry policy:

```bash
infra/scheduler.sh --check staging
infra/scheduler.sh --check production
```

The checks never update a service or create/update a job. Applying a Scheduler
manifest creates recurring-cost jobs and invokes Cloud Run, so do not run the
non-`--check` form without the owner's financial approval.

**The order is: deploy the service, then run `infra/scheduler.sh`.** Until
that has run, the routes answer `503` and nothing is executed: they fail
closed, so skipping this step stops scheduled work rather than leaving it
open. Reading a failed `gcloud scheduler jobs run`: `503` means the
revision serving traffic predates those variables. `401` means the call was
refused — deliberately the same answer whatever the reason, so the response
never tells a prober which check it failed. The reason is in the service's
logs as `[internal/jobs] refused: <reason>` (`missing_token`,
`invalid_token`, `wrong_audience` or `wrong_caller`).

One minute is Cloud Scheduler's floor. It is worth being precise about what
that replaces: the `Scheduler` class that polled every 30 seconds was only
ever constructed from tests, and `/api/reminders/run` returns a snapshot
without advancing any reminder. This closes a gap rather than replacing a
mechanism that was running in production.

## Firestore TTL

The retention manifest is `infra/firestore-ttl.sh`. Verify each database
without changing it:

```bash
infra/firestore-ttl.sh --project maybesitter-app --database staging --check
infra/firestore-ttl.sh --project maybesitter-app --database '(default)' --check
```

The apply form enables every missing policy. Firestore bills TTL-driven deletes,
and enabling a policy can make already-expired documents eligible for bulk
deletion, so a failed check is a financial gate rather than permission to apply.

## Monitoring preparation

`bash infra/cloudrun/ai-cost-alerts.sh print` emits the notification-channel,
Cloud Run 5xx-ratio, max-instance saturation, Vertex usage, global-refusal,
budget-threshold and TTL commands without changing cloud state. The generated
policies are regression-tested by `tests/infra/aiCostAlerts.test.ts`. The
`apply` form creates a user-defined log metric and related monitoring resources;
run it only after approving the possible Observability charges and supplying an
owner-controlled notification email.
