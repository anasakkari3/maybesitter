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

The run creates `durability-<runId>` through the Admin SDK, mints a custom
token, exchanges it for an ID token, and deletes the account in the `finally`
block. `FIREBASE_WEB_API_KEY` comes from the environment; it is not secret, but
it is not committed either.

## Status

The local read-only check and the pure assertion helpers are implemented. The
staging phases need a deployed service (UC-1.0d #143) and Firebase tokens
(UC-1.0e #144); until the owner completes the GCP bootstrap (#140) there is no
staging service to run them against.
