# V03 Closed Pilot Operational Deployment Specification

**Target Cohort**: 25–40 Participants  
**Branch**: `v03/pilot-operations`  
**Status**: `IDENTITY/OPS SCAFFOLD IMPLEMENTED — AUTH INTEGRATION PENDING`  

---

## 1. Architecture & Isolation Model

* **Client**: Flutter Mobile App (`mobile/**`) using OS-backed hardware secure storage (Keychain / KeyStore).
* **Ingress**: HTTPS `api-pilot.maybesitter.com` with TLS 1.3 and WAF. Legacy `/assistant` web interface is strictly blocked.
* **Authentication**: Opaque Pseudonymous Pilot API Tokens (`p-token.<participant_id>.<nonce>.<sig>`). Passed in `Authorization: Bearer <token>`.
* **Persistence**: File-backed storage with per-participant isolated files (`.maybesitter/participants/${participantId}-state.json`).
* **Isolation Verification**: Verified by storage & domain state isolation tests in `tests/pilot/participantIsolation.test.ts`. Request-level HTTP route isolation is specified in `CODEX_AUTH_HANDOFF.md`.

---

## 2. Infrastructure Health Check Endpoint

* **Endpoint**: `GET /api/health`
* **Access**: Unauthenticated, non-sensitive, returns HTTP 200 `{ status: "ok", service: "maybesitter-pilot-backend", timestamp: "..." }`.
* **Purpose**: Used by Cloud Run, Kubernetes, or load balancers for container liveness and readiness probes without exposing user state or requiring pilot credentials.

---

## 3. Cloud Run & Persistent File Storage Reality Check

* **Container Local Disk**: Cloud Run container filesystems are memory-backed ephemeral storage. Writing to local container disk `.maybesitter/participants/` is **UNSAFE** across container restarts, auto-scaling, or instance replacement.
* **Production Storage Requirement**: For a multi-tenant file-backed pilot, `.maybesitter/` MUST be mounted to a persistent network filesystem such as **GCP Cloud Filestore (NFS v3/v4)** mounted via Cloud Run Network VPC Connector.
* **Atomic Write Compatibility**: GCP Cloud Filestore NFS supports standard POSIX atomic file replacement (`renameSync`), matching canonical domain state atomic writes.

---

## 4. Environment Variables & Secret Configuration

Production secret `MAYBESITTER_PILOT_TOKEN_SECRET` is mandatory (min 16 characters). No default production fallbacks exist.

```env
NODE_ENV=production
PORT=3000
MAYBESITTER_DATA_DIR=/mnt/filestore/maybesitter
MAYBESITTER_PILOT_TOKEN_SECRET=<mandatory-32-byte-hex-secret>
MAYBESITTER_CLOSED_PILOT_IDS=p-100,p-101,p-102,...,p-124
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false
LOG_LEVEL=info
```

---

## 5. Operational Runbooks & Emergency Drills

### A. Global Recommendation Kill Switch
```bash
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true
```
* **Effect**: Disable recommendation exposure instantly. Capture and commitments remain operational.

### B. Participant Revocation
```bash
MAYBESITTER_PILOT_TOKEN_SECRET=<secret> npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/revoke-participant.ts <participant_id>
```

### C. Participant Data Deletion
```bash
npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/delete-participant-data.ts <participant_id>
```

### D. Backup & Restore
```bash
npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/backup-pilot-data.ts
```

---

## 6. Cost Estimate (25–40 Participants / Month)

* **Cloud Run (1-2 Instances)**: ~$15 / month
* **GCP Cloud Filestore / Storage Volume**: ~$20 / month
* **LLM Provider API**: ~$30 / month
* **Total Estimated Cost**: **~$65 / month**
