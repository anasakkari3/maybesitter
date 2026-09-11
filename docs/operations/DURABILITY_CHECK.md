# Durability check

Proves that nothing a user confirmed disappears when MaybeSitter redeploys or
runs on several instances. Issue: UC-1.9 (#153).

## When to run it

- Before the closed test (2026-10-28), and before public launch.
- After **any** change to storage, auth or the scheduler.
- After changing Cloud Run scaling or concurrency.

## Two levels

| | Command | Needs | Proves |
|---|---|---|---|
| Local | `scripts/verify-readonly-container.sh` | docker + the Firebase emulators | No code path needs a writable local disk |
| Staging | `node --loader ./scripts/ts-resolver.mjs scripts/verify-durability.ts --base-url <url> --service maybesitter-api-staging --region europe-west1` | owner ADC, a deployed staging service | Concurrent writes, idempotency, consistent consent, survival across a redeploy, and a scheduler job running exactly once |

The local check runs in CI on every push to `main`. The staging run is manual:
it needs the owner's credentials and costs a little.

## The local check

```bash
firebase emulators:start --only firestore,auth   # needs JDK 21+
scripts/verify-readonly-container.sh
```

It builds the real image, runs it with `--read-only` and a 16 MB tmpfs, waits
for `/api/health/ready`, then fails if the service never became ready, if the
logs contain `EROFS`, or if `docker diff` shows anything written outside
`/tmp`. That last check is the strict one: a store that quietly falls back to
the local filesystem is exactly the defect this is here to catch.

**Reading a failure:** look at the container logs it prints. A path under
`/app/.maybesitter` means a store is still file-backed and needs to move onto
the storage adapter (UC-1.0b #141 / UC-1.0c #142).

## The staging run

Phases, in order:

1. **Scale out** — `min-instances=2`, `concurrency=4`, then probe `/api/health`
   until at least two distinct `instanceId`s answer. Without that, nothing
   after this proves anything about multiple instances.
2. **Concurrent writes** — N captures with confirmations, 20 next-step
   decisions sharing one idempotency key, 10 mixed complete/postpone actions on
   one commitment, and 10 alternating consent toggles.
3. **Read everywhere** — 30 parallel reads must each return all N items,
   whichever instance serves them.
4. **Redeploy** — a new revision from the same image; the data, the consent
   state and the feedback history must be unchanged, and a job created before
   the redeploy must complete exactly once.
5. **Cleanup, always** — delete the throwaway account and restore
   `min-instances=0`, `concurrency=40`, removing the run's env var.

The judgements live in `lib/durability/checks.ts` and are unit-tested in
`tests/scripts/verifyDurabilityChecks.test.ts`, so a failing run means the data
was wrong, not that the script misread it.

### Output

A JSON summary on stdout — `{runId, revisions, instances, counts, checks,
durationMs}` — and exit 1 if any check failed. It contains no tokens and no
commitment text.

### Test identity

A throwaway `durability-<runId>@durability.invalid` account, created through
Identity Toolkit's REST `accounts:signUp` with the project's web API key, which
returns a real Firebase ID token. The account is deleted in the `finally`
block, along with its `users/{uid}` tree.

Deliberately **not** `createCustomToken`: that has to be signed by a service
account, which would mean either a JSON key or granting Service Account Token
Creator. No test is worth broadening IAM for.

`FIREBASE_WEB_API_KEY` comes from the environment. It is not a secret — it
ships in mobile clients — but it is not committed either. Read it at run time:

```bash
export FIREBASE_WEB_API_KEY="$(gcloud services api-keys get-key-string \
  "$(gcloud services api-keys list --project maybesitter-app \
     --filter="displayName:'Browser key (auto created by Firebase)'" \
     --format='value(name)' | head -1)" --format='value(keyString)')"
```

Email/Password sign-in must be enabled on the project, otherwise `signUp`
refuses and the run cannot start.

### What the run changes on the service, and puts back

`min-instances=2` and `concurrency=4`, because nothing below phase 1 proves
anything about more than one process — and `MAYBESITTER_FEATURE_RECOMMENDATION=true`,
because the recommendation module is off by default and `decidePilotExposure`
refuses on `feature_disabled` before it ever looks at consent, so the
idempotency phase would otherwise test nothing. All three are undone in
`finally`, including when a check fails, which is exactly when leaving
`min-instances=2` running would quietly cost money.

### What "exactly once" means for the scheduled job

The run writes one due job into `jobs/` — shaped exactly like a job the
product creates — and lets the **real Cloud Scheduler tick** claim it. The
check is that the job made **one attempt** and reached a terminal state. It is
about execution, not business success: the reminder it names does not exist,
so the handler rejects it and the runner fails it without retrying. Two
attempts, or a job still `claimed`, is the failure this catches.


## Status

The local read-only check and the pure assertion helpers are implemented. The
staging phases need a deployed service (UC-1.0d #143) and Firebase tokens
(UC-1.0e #144); until the owner completes the GCP bootstrap (#140) there is no
staging service to run them against.
