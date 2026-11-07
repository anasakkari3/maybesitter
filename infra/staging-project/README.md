# Isolated staging project (Phase 5.8, Option A)

Status: **code only, not provisioned.** The owner declined billing on
2026-11-07, so no project, identity or secret exists yet. Nothing here has run
against Google Cloud except read-only checks.

Staging gets its own GCP + Firebase project. No staging identity has any grant
in production (`maybesitter-app`, 955684917741) and no production identity has
one here. Firestore, Firebase Auth users, secrets, Artifact Registry and the
Workload Identity trust are all separate.

## What gets created

| Thing | Name | Access |
|---|---|---|
| Project | `maybesitter-staging` (or `--project-id`; ids are global, so pick another if taken) | — |
| Firestore | database `staging`, `europe-west1`. Named `staging`, not `(default)`, because the app refuses `MAYBESITTER_ENV=staging` on `(default)` (`lib/storage/firestoreAdapter.ts`) | — |
| Cloud Run | `maybesitter-api-staging` (a placeholder until the first deploy) | public invoker; the app checks every token itself |
| Artifact Registry | `maybesitter` (docker) | `staging-deploy-app`: writer on this repo |
| `staging-run` | runtime | `datastore.user`, `firebaseauth.admin` (project); `secretAccessor` on each staging secret |
| `staging-deploy-app` | `deploy-staging.yml` | `run.developer` on the service only; `artifactregistry.writer` on the repo; `serviceAccountUser` on `staging-run` only; `datastore.indexViewer` (read-only READY check) |
| `staging-deploy-infra` | `infra-staging.yml` | `datastore.indexAdmin`, `firebaserules.admin`, `serviceUsageConsumer` (project) |
| `staging-scheduler` | Cloud Scheduler OIDC | `run.invoker` on the service |
| Secrets | pepper, uid salt, postpone HMAC: **new random values** (`openssl rand`), never copied from production. Football key: a whitespace placeholder, which the app treats as not configured | `staging-run` only |
| WIF | pool `github-staging-app` → `staging-deploy-app`; pool `github-staging-infra` → `staging-deploy-infra` | see below |

**Trust.** Each pool's provider accepts a GitHub token only when
`repository_id == 1205137389`, `environment == staging`, and `job_workflow_ref`
starts with that pool's own workflow file (`deploy-staging.yml@` or
`infra-staging.yml@`). Together they are the condition
`… && (deploy-staging.yml@… || infra-staging.yml@…)`. Two pools, not one,
because an IAM `principalSet` names a pool, not a provider: with one pool, a
token from the app workflow would be valid for the infra identity's binding too.
Mapped attributes: `sub`, `repository`, `repository_id`, `environment`, `ref`,
`job_workflow_ref`, `sha`.

**Not created:** Vertex AI (staging runs with `MAYBESITTER_AI_DISABLED=true`
and cannot spend on the model), Cloud Scheduler jobs (internal job routes answer
503 until `infra/scheduler.sh` is parameterised for this project; each job past
the free three costs $0.10/month), and the KMS key unless `--with-kms` (without
it, Google connect and calendar links answer `not_configured` on staging).

## Cost

About **$0–3/month** at staging volume: Cloud Run at min-instances 0, Firestore
and Secret Manager (4 secrets, ~$0.24/month) mostly within free tiers, Artifact
Registry storage after the 0.5 GB free tier, `--with-kms` adds ~$0.06/month.
Not priced against a billing export; the optional budget alert (`--budget 5USD`,
in the billing account's own currency) alerts only, it does not cap.

## Runbook (owner, in order)

1. **Dry run** (calls nothing): `infra/staging-project/bootstrap.sh`. Read the plan.
2. **Apply**, after approving billing: `infra/staging-project/bootstrap.sh --apply --billing-account <ID> [--budget 5USD] [--with-kms]`.
   Without `--billing-account` it never touches billing and stops after
   creating the (free) project if billing is not enabled. It refuses
   `maybesitter-app` and project number 955684917741, and every gcloud call
   carries an explicit `--project`.
3. **Firebase Auth**: in the console for the new project, enable the sign-in
   providers staging needs (Email/Password at least). Create test users only;
   no production user moves.
4. **GitHub environment `staging`**: add the variables the script prints
   (`STAGING_GCP_PROJECT_ID`, `STAGING_GCP_PROJECT_NUMBER`, `STAGING_REGION`,
   `STAGING_WIF_PROVIDER`, `STAGING_WIF_INFRA_PROVIDER`, `STAGING_DEPLOYER_SA`,
   `STAGING_INFRA_SA`, `STAGING_RUNTIME_SA`) as **environment** variables, and
   add a required reviewer and a deployment branch policy.
5. **Gate**: `infra/staging-project/verify-isolation.sh --project-id <ID>`
   (read-only; exits non-zero on any failed CAN/CANNOT check).
6. **Indexes and rules**: dispatch `infra-staging.yml`. It waits until every
   declared index is READY.
7. **Deploy**: dispatch `deploy-staging.yml`. It refuses to deploy unless the
   indexes are READY, deploys behind a tag, smoke-tests, then moves traffic.

## Mobile staging build

The app currently ships one Firebase config (`mobile/firebase/`). A staging
build that signs in against this project needs its own:

```bash
firebase apps:create IOS "MaybeSitter Staging iOS" --bundle-id com.maybesitter.app --project <ID>
firebase apps:create ANDROID "MaybeSitter Staging Android" --package-name com.maybesitter.app --project <ID>
firebase apps:sdkconfig IOS <ios-app-id> --project <ID>      > GoogleService-Info.staging.plist
firebase apps:sdkconfig ANDROID <android-app-id> --project <ID> > google-services.staging.json
```

Then `mobile/app.config.ts` must pick those files when `APP_ENV=staging`, and
`EXPO_PUBLIC_API_BASE_URL` must be the new service URL. That is a mobile change
not made here. Restrict the new project's API keys to the bundle and package.
Production's config is unchanged.

## Teardown

```bash
gcloud projects delete <ID> --project <ID>
```

Everything above lives in the project, so this removes all of it (30-day
recovery window). Then delete the `STAGING_*` variables from the GitHub
environment. Nothing in production needs undoing, because nothing there was
changed.
