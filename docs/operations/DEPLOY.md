# Deploying the backend

Issue: UC-1.0d (#143). Bootstrap and identities come from UC-1.0a (#140).

> **Status: not yet executed.** `.github/workflows/deploy.yml` is committed
> with a `workflow_dispatch` trigger only and has never run. It cannot run
> until the owner finishes #140 (gcloud installed, authenticated,
> `infra/bootstrap.sh` run, the two repository variables set). The container
> image itself is built and tested locally in CI on every PR.

## Environments

| | Service | Firestore database | Traffic |
|---|---|---|---|
| Staging | `maybesitter-api-staging` | `staging` | manual dispatch |
| Production | `maybesitter-api` | `(default)` | manual dispatch, GitHub environment `production` requires the owner's approval |

Both run in `europe-west1`. Firebase Auth is shared between them, so **staging
is for test accounts only**.

## How a deploy works

1. GitHub Actions authenticates through Workload Identity Federation. There is
   no service-account key anywhere: the pool is pinned to this repository on
   `refs/heads/main`.
2. The image is built from the repository `Dockerfile` and pushed to Artifact
   Registry as `…/maybesitter/api:<sha>`.
3. It deploys **without traffic**, behind the revision tag `sha-<short>`.
4. The tagged revision is probed: `/api/health/ready` must return `ready:true`,
   and `/api/health` must report the same commit that was built.
5. Only then does traffic move to the new revision.
6. Firestore rules and indexes are deployed from `firestore.rules` and
   `firestore.indexes.json`.

Production deploys the **image digest** staging ran, not a rebuilt tag, so the
promoted bytes are the tested bytes.

## Rollback

```bash
gcloud run revisions list --service maybesitter-api --region europe-west1
gcloud run services update-traffic maybesitter-api \
  --region europe-west1 --to-revisions=<revision>=100
```

Traffic moves immediately; no rebuild is involved.

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

## Scheduled work

There is no worker process beside the server. Cloud Scheduler calls the
internal endpoints, and each call carries an OIDC token that the route
verifies (audience + the scheduler service account's email):

| Job | Schedule | Endpoint |
|---|---|---|
| `jobs-tick-{staging,prod}` | `* * * * *` | `/api/internal/jobs/run` |
| `maintenance-daily-{staging,prod}` | `17 3 * * *` Asia/Jerusalem | `/api/internal/jobs/maintenance` |

`infra/scheduler.sh` creates them idempotently. One minute is Cloud
Scheduler's floor, which replaces the old 30-second in-process poll.
