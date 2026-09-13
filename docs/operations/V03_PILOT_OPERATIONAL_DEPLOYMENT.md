# V03-P1 closed-pilot operational runbook

Issue: #55. Operational and trust-incident owner: **Anas Akkari**.

Status: **partly superseded by UC-1.0e (#144)**. The trust, consent, incident
and exposure procedures below still stand. The identity half does not: pilot
tokens, the participant allowlist and their environment variables are deleted,
and the "Token Issuance" and "Participant Revoke" sections are replaced as
marked. This runbook does not authorize pilot deployment, participant
recruitment, or Stage B.

## Architecture

The canonical V03 pilot architecture is:

```text
React Native participant app
-> secure pilot token
-> Authorization: Bearer <token>
-> shared /api/mobile/** backend
-> server-derived participant identity
-> participant-scoped persisted state
```

One shared V03 backend serves the 25-40 allowlisted cohort. The legacy web
pilot model, `/assistant?pilotId=...`, client-supplied participant identity, and
per-participant backend runtime instructions are superseded.

The pilot remains single-writer for V03: Cloud Run **max instances = 1**. The
participant write queue is process-local, so this V03 deployment must not scale
to multiple active writers without a new distributed persistence/locking design.

## Provisioning

Configure the backend with explicit pilot mode and durable storage:

Since UC-1.0e (#144) and UC-1.0b (#141):

```env
NODE_ENV=production
GOOGLE_CLOUD_PROJECT=<project>
MAYBESITTER_STORAGE_BACKEND=firestore
MAYBESITTER_FEATURE_RECOMMENDATION=true
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false
MAYBESITTER_PILOT_INCIDENT_OWNER_ID=<pseudonymous-owner-code>
```

The token secret, the participant allowlist, the pilot-mode flag and the
trust file are gone: identity is a Firebase ID token and durable state is
Firestore. `validateRuntimeConfiguration` fails the boot of any Cloud Run
revision that is missing the project binding, is not on the Firestore
backend, or sets `MAYBESITTER_DEV_AUTH`.

`MAYBESITTER_DATA_DIR` must be an absolute durable path, not container-local
ephemeral disk. For Cloud Run, mount a persistent network filesystem such as
Cloud Filestore and keep Cloud Run `max-instances=1`.

Pilot startup/preflight validation fails closed unless pilot mode has a valid
token secret, a valid 25-40 participant allowlist, and an absolute data
directory. Store production secrets only in the deployment secret manager. Never
commit tokens, token secrets, admin tokens, participant mappings, or real pilot
data.

## Token Issuance — removed

There is nothing to issue. A user signs in with Apple, Google or email; the
client holds a Firebase ID token that expires after an hour and refreshes
itself, and sends it as `Authorization: Bearer <token>` on `/api/mobile/**`.
No operator mints, distributes or stores a credential, and there is no
allowlist to add anyone to. Never log a token; log at most a `sha256(uid)`
prefix.

## Participant Revoke

Revoke a participant when consent is withdrawn or the operator must terminate
pilot access while preserving canonical commitments for later export/deletion:

```bash
GOOGLE_CLOUD_PROJECT=<project> MAYBESITTER_STORAGE_BACKEND=firestore \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/revoke-user.ts <uid>
```

Expected result: `revokeRefreshTokens` invalidates every ID token issued so far
and stops the client minting a new one, and the trust state records
`revokedAt`; recommendation, analytics and calendar consent become false; the
client enters a terminal revoked state. A request carrying an already-issued
token is denied with `401 token_revoked` within 60 seconds — immediately on the
destructive paths, which force a fresh revocation read — and `403 revoked`
once the trust record is read.

## Participant Delete

Delete participant-local state only when the participant explicitly requests
final deletion or the operator must erase that participant's V03 state:

```bash
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter \
MAYBESITTER_PILOT_TRUST_FILE=/mnt/filestore/maybesitter/pilot-trust.json \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/delete-account.ts <uid>   # UC-1.5 (#149): deletes the whole account, with a receipt
```

Expected result: trust state records `deletedAt`; that participant's domain
state and recommendation idempotency file are removed; other participants'
files remain intact; the mobile app clears the local secure token and enters a
terminal deleted state.

## Kill Switch

Turn recommendation exposure off without deleting commitments:

```bash
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true
```

Expected result: the recommendation proposal endpoint answers 200 with no card
and `exposure.reason = kill_switch_active` (silent on the user's screen, legible
in the audit log), and the action endpoint fails closed with 403
`kill_switch_active`; capture, confirmed commitments, trust view, revoke, delete,
and operator incident handling remain available.

Restore eligible recommendation exposure after containment:

```bash
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false
```

Only turn the switch off after the incident owner confirms containment and the
runtime state has been checked.

## Backup

Backups copy only the explicit pilot data root. They do not read or serialize
environment secrets.

```bash
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter \
MAYBESITTER_PILOT_BACKUP_DIR=/mnt/filestore-backups/maybesitter-v03 \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/backup-pilot-data.ts
```

Optional deterministic label for drills:

```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/backup-pilot-data.ts \
  --backup-root /absolute/external/backup/root \
  --label dry-run-001
```

The backup root must be outside `MAYBESITTER_DATA_DIR`. The script rejects a
destination equal to or nested under the source data root, refuses to overwrite
an existing backup, and writes a `pilot-backup-manifest.json` alongside a
`data/` copy containing participant state, recommendation idempotency files,
trust state, audit events, and incidents.

## Restore

Restore only from an explicit backup into an explicit `MAYBESITTER_DATA_DIR`.
Use a fresh target directory whenever possible.

```bash
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter-restored \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/restore-pilot-data.ts \
  --backup /mnt/filestore-backups/maybesitter-v03/pilot-backup-<timestamp>
```

The restore script requires a manifest and backup `data/` directory, rejects
self-referential paths, and refuses to write into a non-empty target unless the
operator passes explicit overwrite intent:

```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/restore-pilot-data.ts \
  --backup /absolute/backup/path \
  --replace-existing
```

After restore, restart the backend with `MAYBESITTER_DATA_DIR` and
`MAYBESITTER_PILOT_TRUST_FILE` pointed at the restored target, then validate at
least one A/B authenticated flow before exposing participants again.

## Incident Response

1. Turn `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`.
2. Keep capture, commitments, trust, revoke, and delete available.
3. Record only privacy-safe incident IDs, timestamps, surface, severity, owner,
   containment code, and resolution code.
4. Do not copy raw participant notes or private text into incident records.
5. Use `GET /api/pilot/incidents` and `PATCH /api/pilot/incidents` with
   `Authorization: Bearer <MAYBESITTER_PILOT_ADMIN_TOKEN>` for operator review.
6. Keep the kill switch on until the incident owner records containment.

## Restart Drill

Before activation and after every restore:

1. Stop the backend cleanly.
2. Start it again with the same durable `MAYBESITTER_DATA_DIR`.
3. Authenticate participant A and participant B with Bearer tokens.
4. Verify A and B commitments remain isolated.
5. Verify trust consent/revoke/delete state persists.
6. Verify recommendation-action idempotency replays instead of duplicating.
7. Verify the kill switch still blocks and restores recommendation exposure.

## Rollback

Operational rollback keeps data controls available:

1. Turn `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`.
2. Preserve the current durable data directory and create an external backup.
3. Revert or redeploy a previously approved Git commit through the normal
   deployment path.
4. Keep revoke/delete procedures available for already-enrolled participants.
5. Rerun the V03 operational and engineering gates before re-enabling exposure.

Do not use force pushes as rollback. Do not delete V03 history. Do not unlock
Stage B through rollback or incident response.

## Cost Estimate

For 25-40 participants/month:

* Cloud Run, max instances 1: about $15
* Persistent storage volume: about $20
* LLM provider API: about $30
* Total estimate: about $65


## Launch v1 cost guardrails (UC-4.5, #181)

The ₪100/month budget is **alert-only**: it notices, it does not stop anything.
The brakes that actually refuse a call live in the application, in
`lib/llm/usageGuard.ts`, and there is exactly one of them — UC-2.0 (#160) built
the per-call reservation and #181 extended it rather than adding a second
counter. Two quota subsystems would mean two answers to "how much has this
account spent today" and no way to tell which was right.

### The limits, and what each one is for

| limit | default | env var | stops |
|---|---|---|---|
| calls per user per day | 60 | `MAYBESITTER_LLM_DAILY_CALL_CAP` | a slow leak, or very heavy use |
| tokens per user per day | 150 000 | `MAYBESITTER_LLM_DAILY_TOKEN_CAP` | sixty *large* calls, which a call cap cannot see |
| calls per user per minute | 8 | `MAYBESITTER_LLM_MINUTE_CALL_CAP` | a client in a retry loop |
| calls across everyone per day | 3 000 | `MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP` | everybody at once |
| characters in one call | 20 000 | — | a paste that costs a day of ordinary use |

Calls are **reserved before** the model is asked; tokens are **committed after**
it answers, because the true count is only known then. Both counters live on one
document per user per UTC day, `users/<uid>/usage/<YYYY-MM-DD>`, with the global
count at `llmUsage/<YYYY-MM-DD>`. Every document carries `expireAt`, seven days
out, for the Firestore TTL policy.

The per-minute window is a field on that same document rather than a document of
its own or an in-process counter. In process it would cap each Cloud Run instance
separately — the real limit becoming the cap times however many instances happen
to be up. In its own document it would double the writes on the hottest path.

### The kill switch

`MAYBESITTER_AI_DISABLED=true` takes every model call out of the product at once:
capture falls back to the rule-based extractor, which is a working product. Set
it in Cloud Run → Edit & deploy new revision → Variables. It is read per call, so
it takes effect on the next request rather than after a restart.

Production ships with it **on** and `MAYBESITTER_LLM_PROVIDER=none`. Turning a
paid model on for real users is not something a deploy should do by itself.

**We do not disable billing programmatically.** That takes the whole app down for
everyone rather than just the model. The caps and this switch are the brakes.

### Cloud Run

`infra/cloudrun/flags.sh` already carried the bounds #181 asks for, from UC-1.0d
(#143): `--timeout=60`, `--concurrency=40`, `--min-instances=0`, and
`--max-instances` of 2 (staging) / 3 (production). Two deliberate differences
from the issue's text:

- **`--memory=1Gi`, not 512Mi.** #143 chose 1Gi against the real image. Halving
  it to match a figure written before that image existed risks an OOM on a cold
  start, and memory is not what the model costs.
- **`--max-instances=3` stands.** #181 made raising it from 1 conditional on no
  process-local write queue remaining. `grep -r "class .*Queue" src lib` finds
  none, so the condition holds.

CPU throttling is the Cloud Run default. The flag that *disables* it
(`--no-cpu-throttling`) is the one that costs money, and it is absent.

### Alarms

`bash infra/cloudrun/ai-cost-alerts.sh print` shows every command;
`apply <email>` creates them. Budgets, threshold rules, log-based metrics and
alert policies are all free — none of this needs new spend.

The application logs one JSON line per refusal, `{"event":"ai_quota_exceeded",
"scope":…,"uidHash":…}`, carrying a scope and a hashed uid and nothing a person
wrote. `global_daily` above zero is the alert that matters: it means everyone is
being refused, which is a different problem from one heavy account.

### Still owner-side

Raising the Vertex per-minute quota to 30 (step 6), the budget threshold rules
(they need the billing account id, which is deliberately not in this
repository), and the 2026-11-04 Firestore usage review.
