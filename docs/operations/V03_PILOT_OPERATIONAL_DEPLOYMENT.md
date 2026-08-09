# V03-P1 closed-pilot operational runbook

Issue: #55. Operational and trust-incident owner: **Anas Akkari**.

Status: engineering code-complete on canonical `main`; this runbook is the
authoritative V03-P1 operational source of truth. It does not authorize pilot
deployment, participant recruitment, or Stage B.

## Architecture

The canonical V03 pilot architecture is:

```text
Flutter participant app
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

```env
NODE_ENV=production
PORT=3000
MAYBESITTER_PILOT_MODE=true
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter
MAYBESITTER_PILOT_TRUST_FILE=/mnt/filestore/maybesitter/pilot-trust.json
MAYBESITTER_PILOT_TOKEN_SECRET=<mandatory-strong-random-secret>
MAYBESITTER_CLOSED_PILOT_IDS=<25-40-comma-separated-pseudonymous-ids>
MAYBESITTER_FEATURE_RECOMMENDATION=true
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false
MAYBESITTER_PILOT_ADMIN_TOKEN=<mandatory-strong-random-admin-token>
MAYBESITTER_PILOT_INCIDENT_OWNER_ID=<pseudonymous-owner-code>
```

`MAYBESITTER_DATA_DIR` must be an absolute durable path, not container-local
ephemeral disk. For Cloud Run, mount a persistent network filesystem such as
Cloud Filestore and keep Cloud Run `max-instances=1`.

Pilot startup/preflight validation fails closed unless pilot mode has a valid
token secret, a valid 25-40 participant allowlist, and an absolute data
directory. Store production secrets only in the deployment secret manager. Never
commit tokens, token secrets, admin tokens, participant mappings, or real pilot
data.

## Token Issuance

Issue one token per pseudonymous participant:

```bash
MAYBESITTER_PILOT_TOKEN_SECRET=<secret> \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/issue-pilot-token.ts <participant_id>
```

Distribute the raw token through the approved out-of-band pilot process. Do not
store raw tokens in Git, tickets, logs, screenshots, or analytics. The Flutter
app stores the token in OS secure storage and sends it as `Authorization:
Bearer <token>` on canonical `/api/mobile/**` requests.

## Participant Revoke

Revoke a participant when consent is withdrawn or the operator must terminate
pilot access while preserving canonical commitments for later export/deletion:

```bash
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter \
MAYBESITTER_PILOT_TRUST_FILE=/mnt/filestore/maybesitter/pilot-trust.json \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/revoke-participant.ts <participant_id>
```

Expected result: the trust state records `revokedAt`; recommendation, analytics,
and calendar consent become false; the client enters a terminal revoked state;
future use of the participant token is denied with `403 revoked`.

## Participant Delete

Delete participant-local state only when the participant explicitly requests
final deletion or the operator must erase that participant's V03 state:

```bash
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter \
MAYBESITTER_PILOT_TRUST_FILE=/mnt/filestore/maybesitter/pilot-trust.json \
node --no-warnings --loader ./scripts/ts-resolver.mjs \
  scripts/delete-participant-data.ts <participant_id>
```

Expected result: trust state records `deletedAt`; that participant's domain
state and recommendation idempotency file are removed; other participants'
files remain intact; the Flutter app clears the local secure token and enters a
terminal deleted state.

## Kill Switch

Turn recommendation exposure off without deleting commitments:

```bash
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true
```

Expected result: recommendation proposal/action endpoints fail closed with
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

