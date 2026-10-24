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
| `maybesitter-deployer` | GitHub Actions deploys through WIF and invokes the M5a control endpoint | `roles/run.admin` (including the service-specific Cloud Run invoker grant; it has no Firestore document role), `roles/firebaserules.admin`, `roles/datastore.indexAdmin`, `roles/serviceusage.serviceUsageConsumer`, `roles/artifactregistry.writer` (repository only), `roles/iam.serviceAccountUser` (on `maybesitter-run` only) |
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
| `captureConversations` | 24 hours after the last turn | a capture-chat conversation: the person's messages and the assistant's replies |
| `goalStatementPreviews` | 30 minutes | an owned goal summary awaiting explicit acceptance |

The stores stamp `expiresAt` on every write, but **a stamp does nothing until
the policy exists**. Nothing in the bootstrap or the deploy workflow creates
it, so this is an owner step, and skipping it means raw capture text is never
deleted. Run it for each database — the script defaults to `(default)`, so
staging needs its own run:

```bash
infra/firestore-ttl.sh --project maybesitter-app --check                    # production, read-only
infra/firestore-ttl.sh --project maybesitter-app --database staging --check # staging, read-only
infra/firestore-ttl.sh --project maybesitter-app --dry-run                  # print apply commands
# Apply only after approving billed TTL deletes and the deletion of any
# already-expired documents:
infra/firestore-ttl.sh --project maybesitter-app
infra/firestore-ttl.sh --project maybesitter-app --database staging
gcloud firestore fields ttls list --project=maybesitter-app     # verify: every required policy ACTIVE
```

It is idempotent. Re-run it whenever a store adds a collection with an
`expiresAt`, and keep the list in the script in step with the table above.

TTL deletion is eventual (Firestore deletes within about 24 hours of the
stamp), so the nightly maintenance job (`/api/internal/jobs/maintenance`,
added by UC-1.0d #143) also prunes expired traces and clarifications. Two
stores have no TTL at all — runtime memory and alpha feedback — and are
retained **only** by that nightly prune, so until it runs they keep everything.

## Rotating the deletion-receipt pepper

Rotation is supported only by the steps below (#798). Read all of them first.
Each step that creates a secret version, changes traffic or removes a tag
**changes cloud state and is an owner action**. Every other step is a commit,
a deploy, or a read-only check.

### What the pepper does, and why rotation is two deploys

`maybesitter-deletion-receipt-pepper` (one Secret Manager secret, mounted on
both services) is an HMAC key. It has three uses:

1. the subject hash on deletion receipts (`deletionReceipts/*`, kept 400 days);
2. the id of each deletion job, `accountDeletions/{HMAC(pepper, uid)}`, which
   is also the **deletion tombstone**. A uid's first request reads it before
   it creates `users/{uid}`, and so blocks the #794 race;
3. the `accountKey` on a Google grant-revoke obligation in
   `oauthCleanupObligations/*` (#800, `HMAC(pepper, 'google_<sub>')`). It
   serves one optimisation: a successful connect of that Google account
   clears its pending revocations by `accountKey`, under the current and the
   previous pepper. It is not what protects the new connection. Before every
   revoke, the nightly retry asks whether any live account holds a live
   connection to that Google account (check 1 in
   `lib/integrations/providers/production/oauthCleanupObligations.ts`), and
   drops the obligation if one does. That check is a collection-group query
   on the sealed Google `sub`. It needs no pepper and no `accountKey`, so a
   rotation cannot weaken it.

Uses 1 and 2 must be found under either key while a rotation is active. Use 3
should be, but missing it costs only the optimisation. The app reads up to two
keys:

| Variable | Source | Meaning |
|---|---|---|
| `MAYBESITTER_DELETION_RECEIPT_PEPPER` | secret, pinned version | the newest key |
| `MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS` | secret, pinned version | the old key, during a rotation only |
| `MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE` | plain env | which key **new** records use: `current` (default) or `previous` |

Readers always check every configured key: tombstones, job lookup before a
new job is minted, and obligation clearing. Writers use the selected key: new
deletion jobs, and an obligation's `accountKey`. The obligation recorder takes
the first entry of `providerAccountKeys` (`pepperedSubjectHashes`), and that
list puts the writer's key first. A stalled job is resumed at the path where it is stored, so a
job begun under the old key is finished under the old key, and finishing it
needs no pepper at all.

**The invariant:** the key any live revision writes is a key that every live
revision reads. A deploy serves the old and the new revision together, for at
least the 60 s request timeout, and longer through a revision tag. So no single
deploy can move both what a revision reads and what it writes:

| Phase | `pepper-rotation.env` | Reads | Writes |
|---|---|---|---|
| steady (before) | `steady`, `current_version=N` | N | N |
| 1, readers | `readers`, `current=N+1`, `previous=N` | N+1, N | N |
| 2, writer | `writer`, `current=N+1`, `previous=N` | N+1, N | N+1 |
| steady (after) | `steady`, `current_version=N+1` | N+1 | N+1 |

Each adjacent pair satisfies the invariant. Skipping phase 1 would not: a
steady-N revision would miss tombstones that a phase-2 revision wrote.
`tests/account/pepperRotation798.test.ts` replays every adjacent pair against
the real engine, using the env that `flags.sh` emits for each phase.

Why a writer selector rather than swapping PEPPER and PREVIOUS: a swap is also
safe, but it makes `PREVIOUS` name the *newer* key during phase 1. With the
selector, `PEPPER` always names the newest key and only one value moves per
phase. Rolling back phase 2 is then the same one-value change.

### How deploys carry it

`infra/cloudrun/flags.sh` reads the committed
`infra/cloudrun/pepper-rotation.env` on every deploy. The file sets the phase
and versions **per service**. Each service has its own Firestore database, and
production deploys only by hand. From the file, `flags.sh` emits:

- the pinned `PEPPER` mapping;
- the `PREVIOUS` mapping in phases `readers` and `writer`;
- `WRITE` in every phase, `current` included. `--update-env-vars` merges, so
  a `previous` left on the service would otherwise survive the return to
  steady.

`flags.sh` refuses a malformed file: a missing or duplicate key, `latest`
during a rotation, the same version twice, or `previous_version` while steady.
A deploy then fails instead of guessing. `--set-secrets` replaces the whole
mounted set, which is why a `PREVIOUS` added by hand would be dropped by the
next merge to main. Never add one by hand.

A production deploy runs a commit that staging has already built. So each
production step below is: merge the commit to `main` (staging redeploys with
its own state unchanged), then dispatch the production deploy of that commit.
Roll staging through each phase before production.

### Step 0: pin the version in use (commit + deploy)

`latest` names whichever version is newest, so a new version must never
appear while a service still maps `latest`. Find the version both services
run now (read-only):

```bash
gcloud secrets versions list maybesitter-deletion-receipt-pepper --project=maybesitter-app
```

If exactly one version is `enabled`, that is N. If there are several, stop:
work out which one each live revision resolved before going on. Set
`staging_current_version=N` and `production_current_version=N` (phases stay
`steady`). Merge, deploy staging, dispatch production, and verify that each
service's latest revision mounts version N:

```bash
for svc in maybesitter-api-staging maybesitter-api; do
  gcloud run services describe "$svc" --region=europe-west1 --format=json \
    | jq -r '.spec.template.spec.containers[0].env[]
             | select(.name|startswith("MAYBESITTER_DELETION_RECEIPT_PEPPER"))
             | "\(.name) \(.valueFrom.secretKeyRef.key // .value)"'
done
```

The output shows only names and version numbers, never the secret value.
Expect `MAYBESITTER_DELETION_RECEIPT_PEPPER N` and
`MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE current`.

**Revision tags.** Every deploy leaves its revision reachable through a
`sha-*` tag URL, even at 0% traffic. A revision that still maps `latest`
would read N+1 alone as soon as step 1 creates it. Before step 1, list the
tags (read-only):

```bash
gcloud run services describe <svc> --region=europe-west1 --format=json | jq '.status.traffic'
```

Then remove (owner action) every tag that points at a revision from before
this step:

```bash
gcloud run services update-traffic <svc> --region=europe-west1 --remove-tags=sha-xxxxxxx
```

The same check and removal come back before phase 2 and before step 4. Each
time, the target is every tag older than the phase just deployed.

### Step 1: create the new version (owner action)

```bash
openssl rand -base64 48 | tr -d '\n' \
  | gcloud secrets versions add maybesitter-deletion-receipt-pepper \
      --project=maybesitter-app --data-file=-
```

Note the new version number, N+1. Never echo, paste or store the value
anywhere else. Both services are pinned to N, so nothing changes yet. From
here on `latest` is N+1, which no live revision reads. So nothing may fetch
the pepper by `latest` any more. The operator recipe in
`ACCOUNT_DELETION.md` reads the version from the service itself, for this
reason.

### Step 2: phase 1, readers (per service: commit + deploy)

Set `<service>_phase=readers`, `<service>_current_version=N+1` and
`<service>_previous_version=N`. Merge and deploy. Verify with the loop above.
Expect:

- `PEPPER N+1`
- `PEPPER_PREVIOUS N`
- `PEPPER_WRITE previous`

Also check that the new revision serves 100% of traffic and that
`/api/health/ready` answers `"ready":true`.

**Operator shells.** From now until step 4, an operator running
`scripts/delete-account.ts` against this service must carry the same three
values that the service mounts. The recipe in `ACCOUNT_DELETION.md` reads
them from the service, so it follows every phase on its own.

### Wait before phase 2

Each condition must hold for the service you are about to switch:

1. The phase-1 revision serves 100% of traffic, and at least **10 minutes**
   have passed since it took traffic. The request timeout is 60 s; the
   margin covers retries and the scheduler.
2. **No pre-phase-1 revision can be reached.** Remove (owner action) every
   tag that points at a revision older than phase 1, as in step 0.
3. No operator shell or one-off job still runs with the steady-state env.

### Step 3: phase 2, writer (per service: commit + deploy)

Set `<service>_phase=writer` and leave the versions as they are. Merge and
deploy. Verify that `PEPPER_WRITE current` appears and that `PEPPER_PREVIOUS N`
**is still mounted**.

Phase-1 revisions still write key N, and their `sha-*` tags keep them
reachable after phase 2 takes traffic. Remove (owner action) every tag that
points at a revision older than phase 2, as in step 0. Then wait 10 minutes,
with the phase-2 revision serving 100% of traffic. Record that moment as
**T2** for this service, in UTC ISO form (for example
`2026-11-02T09:30:00.000Z`). From T2, no reachable revision writes key N, so
every new record written under key N is dated before T2. A job already begun
under key N can still be finished after T2; step 4's check 2 waits for those.

### Step 4: back to steady on N+1 (per service: commit + deploy)

`PREVIOUS` may be dropped only once nothing written under key N can still
matter. All checks are read-only. Checks 0 to 2 must pass; item 3 is a note,
not a gate. Run the queries against the service's own database: `staging` for
staging, `(default)` for production.

0. **No revision older than phase 2 can be reached**: the step 3 tag removal
   held, and the `.status.traffic` listing shows no tag on such a revision.
1. At least **31 days after T2**: a finished job is kept 30 days, plus a day
   for TTL lag.
2. **No deletion job from before T2 remains**, done or not. This covers a job
   that is in progress or stuck under key N; a repeat request would no longer
   find it.
3. *Note, not a gate:* OAuth cleanup obligations from before T2 carry a
   key-N `accountKey`. Once `PREVIOUS` is gone, a later connect of that
   Google account no longer clears them early. Nothing else changes. The
   nightly retry still runs check 1 before every revoke and drops the
   obligation if a live connection holds that authorization. So a leftover
   loses only the optimisation, never the protection. The second query below
   counts them, if you want to know.

For check 2, the first query must print `0`. Each query selects only
`status` or `kind`, so no uid or key is printed:

```bash
DB=staging   # or '(default)'
T2=2026-11-02T09:30:00.000Z
q() {
  curl -fsS -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H 'Content-Type: application/json' \
    "https://firestore.googleapis.com/v1/projects/maybesitter-app/databases/${DB}/documents:runQuery" \
    -d "{\"structuredQuery\":{\"from\":[{\"collectionId\":\"$1\"}],\"where\":{\"fieldFilter\":{\"field\":{\"fieldPath\":\"$2\"},\"op\":\"LESS_THAN\",\"value\":{\"stringValue\":\"${T2}\"}}},\"select\":{\"fields\":[{\"fieldPath\":\"$3\"}]},\"limit\":20}}" \
    | jq '[.[] | select(.document)] | length'
}
q accountDeletions startedAt status          # check 2: must be 0
q oauthCleanupObligations createdAt kind     # note 3: informational
```

Then set `<service>_phase=steady`, `<service>_current_version=N+1` and
`<service>_previous_version=` (empty). Merge and deploy. Verify that the
output shows `PEPPER N+1` and `PEPPER_WRITE current`, and **no**
`PEPPER_PREVIOUS`.

### Afterwards: the old version

Receipts written under key N are kept for 400 days. Answering "prove you
deleted me" for one of them needs key N. A key-N job finished after T2 still
writes a key-N receipt. Step 4's check 2 is what proves that no such job
remains. So the last key-N receipt predates the step-4 deploy of its service.
Once both services are steady on N+1, the owner may **disable** version N. Do
not **destroy** it until 400 days after the later of the two step-4 deploy
dates.

### Rollback

| From | To | How | Why it is safe |
|---|---|---|---|
| phase 1 | steady on N | `steady`, `current_version=N`, `previous_version=` empty | phase 1 wrote only key N, so nothing under N+1 exists |
| phase 2 | phase 1 | `readers` (versions unchanged) | both phases read both keys |
| phase 2 | steady on N | **never directly** | go to phase 1 first, then follow step 4's three checks with T2 replaced by the rollback time, since records written under N+1 must age out |
| steady on N+1 | earlier | a new rotation (N+1 to N+2) | the old version is not reused |

Every rollback is a commit to `pepper-rotation.env` and a deploy. **Never
roll back by moving traffic**, whether with `gcloud run services
update-traffic --to-revisions=…` or the console's "manage traffic", to a
revision more than one phase away. A steady-N revision given traffic during
phase 2 is exactly the old-reader / new-writer gap.

If a phase deploy fails its smoke test, the previous revision keeps serving.
Revert the commit to `pepper-rotation.env` before the next merge, or the next
staging deploy retries it.

### What the tests pin

- `tests/account/pepperRotation798.test.ts`:
  - an old-key job is finished at its stored path;
  - a repeat request finds the old-key job or tombstone and mints no second
    job;
  - an old-key tombstone blocks a first request in phases 1 and 2;
  - the writer selector is honoured;
  - the revision pairs replayed from `flags.sh` output.
- `tests/infra/pepperRotation798.test.ts`:
  - `flags.sh` keeps `PREVIOUS` while a rotation is active and omits it
    otherwise;
  - `flags.sh` refuses a malformed state.

## What this repository must never contain

- a service-account JSON key
- a billing account id or a project number
- a personal email address
- any secret value

`infra/verify.sh` checks the first of those against the live project; the rest
are checked by grep in CI.
