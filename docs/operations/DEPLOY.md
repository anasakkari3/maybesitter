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

## M5a durable activation and kill procedure

M5a is production-pinned-off. In local/test/staging, do not enable either
durable control until the M5a revision has served **100 %** of traffic for at
least **10 minutes**. This drains every pre-M5a writer before selection and
Google certificates can be trusted.

### Prerequisites on each service (#810)

Production needs all of these before M5a is enabled there; staging has them
since 2026-10-24. `infra/scheduler.sh --check <staging|production>` reports
each one missing.

1. **`MAYBESITTER_DEPLOYER_SA_EMAIL=maybesitter-deployer@<project>.iam.gserviceaccount.com`**
   on the service. `/api/internal/m5a-controls` accepts that caller and no
   other; without the variable, init, enable **and kill** answer 503
   `not_configured`. `infra/cloudrun/flags.sh` sets it on both services, so
   any deploy from this revision on carries it. A service last deployed before
   then needs a redeploy. The check prints
   `FAIL <service> MAYBESITTER_DEPLOYER_SA_EMAIL is missing`.
2. **`MAYBESITTER_INTERNAL_AUDIENCE`** (the service URL), which
   `infra/scheduler.sh` sets. The route checks the token's audience against
   it, just as the scheduled jobs do.
3. **The Cloud Scheduler job `intelligence-gmail-sweep-<staging|prod>`**,
   which `infra/scheduler.sh` creates. It continues Gmail scans page by page.
   Without it, a manual M5a scan lists its first page and never advances (its
   count stays at 0). It was missing on staging on 2026-10-24. Applying
   `infra/scheduler.sh` is idempotent, but it creates recurring-cost jobs, so
   it needs the owner's approval (see [Scheduled work](#scheduled-work)).

### Running the control scripts as the deployer

Only GitHub's Workload Identity Federation can impersonate
`maybesitter-deployer` by default, so an operator who runs the scripts by hand
needs a **temporary** grant, removed as soon as the step is done:

```bash
DEPLOYER=maybesitter-deployer@maybesitter-app.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --project=maybesitter-app \
  --member="user:<operator e-mail>" --role=roles/iam.serviceAccountTokenCreator

export MAYBESITTER_INTERNAL_AUDIENCE="$(gcloud run services describe <service> \
  --region=europe-west1 --project=maybesitter-app --format='value(status.url)')"
# --include-email: the route needs the token's email and email_verified
# claims, and an impersonated token has neither without it.
export M5A_CONTROLS_ID_TOKEN="$(gcloud auth print-identity-token \
  --impersonate-service-account="$DEPLOYER" \
  --audiences="$MAYBESITTER_INTERNAL_AUDIENCE" --include-email)"
# … run the script(s) below. The token lasts about an hour …

gcloud iam service-accounts remove-iam-policy-binding "$DEPLOYER" \
  --project=maybesitter-app \
  --member="user:<operator e-mail>" --role=roles/iam.serviceAccountTokenCreator
```

Never leave the binding in place: whoever holds it can deploy both services.
For an incident kill, grant it, run the kill, and remove it in the same
session.

### Activation

With `MAYBESITTER_INTERNAL_AUDIENCE` and the deployer token from the previous
section in the environment, on first deployment run
`node --loader ./scripts/ts-resolver.mjs scripts/m5a-controls-init.ts`; this is
create-only and provisions both controls disabled at epoch zero. After the
traffic precondition, enable one capability with
`scripts/m5a-enable.ts calendar <expectedEpoch>` or
`scripts/m5a-enable.ts email <expectedEpoch>`.

For an incident, first run `scripts/m5a-kill.ts <calendar|email>`. The internal
endpoint atomically disables that control, advances its epoch, and appends the
new epoch to `system/m5aControlsLog`; only then change the revision flag. This
order fences work admitted before the flag revision.

If `system/m5aControls` is missing or corrupt, stop both Gmail jobs, drain the
M5a revision, and wait past every lease (at least 120 seconds). Read the highest
epoch per capability from `system/m5aControlsLog`, recover a document whose
epochs are strictly greater and whose two controls are disabled, then repeat
the 10-minute activation precondition and explicit enable steps. Never reuse
an epoch and never give the deployer direct Firestore access.

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
- **One product (owner decision, 2026-09-29).** Production gets the same
  features as staging: the hosted model, memory, football fixtures and
  calendar links. What still differs is deliberate: the Firestore database,
  `--max-instances`, the global model cap and `MAYBESITTER_SITE_ORIGINS`.
- The hosted model (`MAYBESITTER_LLM_PROVIDER=gemini`) and the memory module
  (`MAYBESITTER_FEATURE_MEMORY=true`) are on in both environments (production:
  the owner approved the spend on 2026-09-29). Both kill switches,
  `MAYBESITTER_AI_DISABLED` and `MAYBESITTER_KILL_SWITCH_MEMORY`, are set to
  `false` rather than left unset, so turning either off in an incident is a
  one-value change on the service. Production's global cap,
  `MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP`, is 500 calls/day (staging 3000).
  Worst case at that cap is about $4–8/day (~$120–240/month): 20,000-character
  inputs, 2,048-token outputs and one billed retry per call. The two
  prerequisites the spend decision named are in the repository: a
  production-scoped alert, "Production model calls above 400/day" (80% of the
  cap, counted from production's own `llm_call` log lines; the "Vertex AI
  requests above 1500/day" alert counts the whole project, which staging alone
  can exceed), which an operator creates with `ai-cost-alerts.sh apply`; and
  `MAYBESITTER_LLM_UID_SALT`, mounted from Secret Manager on both services, so
  model logs carry a salted hash of each uid. About 8 heavy users exhaust
  500/day, after which everyone falls back to the rule-based path until UTC
  midnight.
- `MAYBESITTER_KMS_KEY_NAME` (the `user-secrets` key) on both services. It
  seals Google refresh tokens and ICS feed URLs; without it Google connect
  answers `not_configured`. It used to be set on staging by hand only.
- `ICS_FEEDS_ENABLED` (calendar links, UC-3.4 #188): `true` on both services
  (production by the owner decision of 2026-09-29), written explicitly so an
  operator turns it off with one value. It gates
  `/api/mobile/calendar/ics/**` and the `ics-feed-refresh` job; unset, every
  call answers 404 `feature_disabled` and the app has nothing to offer
  (owner's phone, 2026-09-29). Feed URLs are sealed with
  `MAYBESITTER_KMS_KEY_NAME`, so no other variable is needed.
- `MAYBESITTER_SITE_ORIGINS` on production only: `https://maybesitter.com`,
  `https://maybesitter-app.web.app`, `https://maybesitter-app.firebaseapp.com`,
  the exact origins the early-access form may post from. `www` redirects to
  the apex at Hosting, so it is not listed.
- `MAYBESITTER_DEPLOYER_SA_EMAIL` (`maybesitter-deployer@<project>…`) on both
  services: the only caller `/api/internal/m5a-controls` accepts (#810). See
  [M5a](#m5a-durable-activation-and-kill-procedure).
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

Both services mount the same three secrets (the runtime SA has
`secretAccessor` on each, checked 2026-09-29):

| Env var | Secret | Used by |
| --- | --- | --- |
| `MAYBESITTER_DELETION_RECEIPT_PEPPER` | `maybesitter-deletion-receipt-pepper` | deletion receipts |
| `MAYBESITTER_LLM_UID_SALT` | `maybesitter-llm-uid-salt` | the uid hash in model log lines (`lib/llm/llmLog.ts`) |
| `FOOTBALL_DATA_API_KEY` | `maybesitter-football-data-api-key` | football fixtures (football-data.org) |

The football credential was first synced on staging (2026-09-28); production
mounts it by the owner decision of 2026-09-29. `--set-secrets` replaces the
service's whole secret set, so a secret added by hand and not listed in
`flags.sh` is removed by the next deploy.

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
| `intelligence-gmail-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/intelligence-gmail` |
| `intelligence-gmail-sweep-{staging,prod}` | `* * * * *` UTC | `/api/internal/jobs/intelligence-gmail-sweep` |

`infra/scheduler.sh <staging|production>` creates all ten jobs idempotently, and
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

The M5a controls route takes a third, `MAYBESITTER_DEPLOYER_SA_EMAIL`, which
is static and therefore set by `infra/cloudrun/flags.sh` (see
[M5a](#m5a-durable-activation-and-kill-procedure)). `tests/infra/internalRouteEnv.test.ts`
fails when an internal route reads a variable that neither script sets.

Before applying anything, the read-only check verifies the Cloud Run identity
variables (including `MAYBESITTER_DEPLOYER_SA_EMAIL`) plus every job's enabled state, schedule, target, method, OIDC caller,
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
production model calls (above 400/day on `maybesitter-api`), budget-threshold
and TTL commands without changing cloud state. The generated
policies are regression-tested by `tests/infra/aiCostAlerts.test.ts`. The
`apply` form creates two user-defined log metrics and related monitoring resources;
run it only after approving the possible Observability charges and supplying an
owner-controlled notification email.
