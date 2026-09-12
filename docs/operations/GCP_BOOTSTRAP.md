# GCP and Firebase bootstrap

How the MaybeSitter cloud project is created, and how to prove it is still
correct. Everything here is reproducible from the repository: if the console
and these scripts disagree, the scripts win — re-run them.

Issue: UC-1.0a (#140).

## What exists

| Thing | Value |
|---|---|
| Project | `maybesitter-app` |
| Region (everything regional) | `europe-west1` |
| Firestore | `(default)` for production and `staging` for the staging service — both Native mode, PITR on, delete protection on, same rules and indexes |
| Artifact Registry | `maybesitter` (Docker), keeps the 10 most recent versions |
| Secret container | `maybesitter-deletion-receipt-pepper` (value added by the owner) |
| Service accounts | `maybesitter-run`, `maybesitter-deployer`, `maybesitter-scheduler` |
| Deploy identity | Workload Identity Federation, no JSON keys |

### Why `europe-west1`

A Firestore database's location can never be changed, so it has to be a region
where every service this product will need is fully available. Cloud Run,
Cloud Scheduler, Artifact Registry and Vertex AI Gemini are all GA in
`europe-west1` with the full model catalogue. `me-west1` (Tel Aviv) has a
narrower Vertex model list and Tier-2 pricing, which matters under a small
monthly budget. Round-trip time from Israel is roughly 60 ms, which is fine for
this API, and Israeli privacy law permits transfer to EU member states. The
database is regional rather than multi-region because it is cheaper and
point-in-time recovery covers the recovery story.

This choice is also a promise to users: the privacy policy states that data is
stored in the EU.

## Service accounts and roles

Least privilege from the first day. Nothing here holds `roles/editor` or
`roles/owner`.

| Service account | Purpose | Roles |
|---|---|---|
| `maybesitter-run` | Cloud Run runtime | `roles/datastore.user`, `roles/firebaseauth.admin`, and `roles/secretmanager.secretAccessor` **on the deletion-receipt secret only** |
| `maybesitter-deployer` | GitHub Actions deploys through WIF | `roles/run.admin` (making the service public with `--allow-unauthenticated` needs `run.services.setIamPolicy`, which `run.developer` lacks), `roles/firebaserules.admin`, `roles/datastore.indexAdmin`, `roles/serviceusage.serviceUsageConsumer` (firebase-tools checks the Firestore API is enabled before deploying rules, and fails on a 403), `roles/artifactregistry.writer` (on the `maybesitter` repository only), `roles/iam.serviceAccountUser` (on `maybesitter-run` only) |
| `maybesitter-scheduler` | The identity Cloud Scheduler signs OIDC tokens as | none at project level — the app authorises it by checking the token's email |

`roles/firebaseauth.admin` is what lets the backend verify, revoke and delete
users, which account deletion needs.

**No service account may have a user-managed key.** `infra/verify.sh` fails if
one appears. Deploys authenticate through Workload Identity Federation, which
is restricted to this repository on `refs/heads/main`.

## Owner steps (an agent must not do these)

These need a browser, a payment method or an Apple/Google account, so they are
yours:

```bash
brew install --cask google-cloud-sdk
gcloud auth login
gcloud auth application-default login
gcloud config set project maybesitter-app
firebase login
```

Then, after running the bootstrap:

1. **Secret value** — generate it without echoing it:
   ```bash
   openssl rand -hex 32 | gcloud secrets versions add maybesitter-deletion-receipt-pepper --data-file=-
   ```
2. **Firebase console → Authentication → Sign-in method**: enable
   Email/Password, Google and Apple. Apple needs a Services ID and a key from
   the Apple Developer account; the `.p8` never enters this repository.
3. **GCP console → Credentials**: restrict the auto-created API keys to the iOS
   bundle and the Android package (`com.maybesitter.app`).
4. **GitHub → Settings → Variables** (repository *variables*, not secrets, and
   never a key file): set `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA` to the two
   values the bootstrap prints at the end.
5. **Budget**: keep the alert-only budget and confirm thresholds at 50/90/100%.

Never paste a token, a key or a billing account id into a file, an issue or a
chat.

## Running it

```bash
GITHUB_REPOSITORY=anasakkari3/maybesitter infra/bootstrap.sh
infra/verify.sh
```

`bootstrap.sh` is idempotent: every create is guarded by a describe, so running
it twice changes nothing the second time. `verify.sh` exits non-zero on the
first thing that is wrong and prints one line per check, so it can gate a
deploy.

`firebase deploy --only firestore:rules,firestore:indexes` publishes the
deny-all baseline in `firestore.rules` and the (currently empty)
`firestore.indexes.json`. UC-1.0b (#141) replaces the rules with per-user read
access.

## Retention policies (TTL) — run once per database

Three collections keep data for a limited time rather than for the life of the
account, and Firestore enforces that with a TTL policy on `expiresAt`:

| Collection group | Kept for | Holds |
|---|---|---|
| `alphaTraces` | 30 days | raw capture text, kept for alpha review |
| `clarifications` | 24 hours | a half-finished question |
| `analyticsEvents` | 400 days | product metrics |
| `captureProposals` | 24 hours | a capture awaiting confirmation |

The stores stamp `expiresAt` on every write, but **a stamp does nothing until
the policy exists**. Nothing in the bootstrap or the deploy workflow creates
it, so this is an owner step, and skipping it means raw capture text is never
deleted. Run it for each database — the script defaults to `(default)`, so
staging needs its own run:

```bash
infra/firestore-ttl.sh --project maybesitter-app --dry-run      # see what it will do
infra/firestore-ttl.sh --project maybesitter-app                # production, (default)
infra/firestore-ttl.sh --project maybesitter-app --database staging
gcloud firestore fields ttls list --project=maybesitter-app     # verify: all three ACTIVE
```

It is idempotent. Re-run it whenever a store adds a collection with an
`expiresAt`, and keep the list in the script in step with the table above.

TTL deletion is eventual (Firestore deletes within about 24 hours of the
stamp), so the nightly maintenance job (`/api/internal/jobs/maintenance`,
added by UC-1.0d #143) also prunes expired traces and clarifications. Two
stores have no TTL at all — runtime memory and alpha feedback — and are
retained **only** by that nightly prune, so until it runs they keep everything.

## Rotating the deletion-receipt pepper

The pepper is only used to derive deletion receipts, so rotating it invalidates
old receipts but loses no user data:

```bash
openssl rand -hex 32 | gcloud secrets versions add maybesitter-deletion-receipt-pepper --data-file=-
gcloud run services update maybesitter-api --region europe-west1 \
  --update-secrets MAYBESITTER_DELETION_RECEIPT_PEPPER=maybesitter-deletion-receipt-pepper:latest
```

Cloud Run pins `:latest` at deploy time, so the service has to be updated for a
new version to take effect.

## What this repository must never contain

- a service-account JSON key
- a billing account id or a project number
- a personal email address
- any secret value

`infra/verify.sh` checks the first of those against the live project; the rest
are checked by grep in CI.
