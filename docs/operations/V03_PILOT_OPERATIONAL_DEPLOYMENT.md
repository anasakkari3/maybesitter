# V03 Closed Pilot Operational Deployment Specification

**Target Cohort**: 25–40 Participants  
**Branch**: `v03/pilot-operations`  
**Status**: `CONFIGURED & TESTED (DEPLOYMENT FROZEN)`  

---

## 1. Architecture & Isolation Model

* **Client**: Flutter Mobile App (`mobile/**`).
* **Ingress**: HTTPS `api-pilot.maybesitter.com` with TLS 1.3 and WAF. Legacy `/assistant` web interface is strictly blocked.
* **Authentication**: Opaque Pseudonymous Pilot API Tokens (`p-token.<participant_id>.<nonce>.<sig>`).
* **Persistence**: File-backed storage with per-participant isolated files (`.maybesitter/participants/${participantId}-state.json`).
* **Isolation Verification**: Verified by 6 adversarial tests in `tests/pilot/participantIsolation.test.ts` (Cross-tenant fetch, mutation, trust state access, non-allowlisted access, and experiment arm tampering all fail closed).

---

## 2. Environment Variables & Secret Configuration

Production secrets are kept out of git. Environment template:

```env
NODE_ENV=production
PORT=3000
MAYBESITTER_DATA_DIR=/var/data/maybesitter
MAYBESITTER_PILOT_TOKEN_SECRET=<32-byte-hex-secret>
MAYBESITTER_CLOSED_PILOT_IDS=p-100,p-101,p-102,...,p-124
MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID=p-100
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false
LOG_LEVEL=info
```

---

## 3. Operational Runbooks & Emergency Drills

### A. Global Recommendation Kill Switch
To instantly disable AI recommendation / next-step exposure across all participants without affecting capture or commitment persistence:
```bash
# In runtime controls or environment
MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true
```
* **Effect**: All `/api/pilot/*` and recommendation surfaces return `{ allowed: false, reason: "kill_switch_active" }`.
* **Data Safety**: Zero data loss. Capture and commitments remain 100% operational.

### B. Participant Revocation
To immediately revoke a participant's access:
```bash
npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/revoke-participant.ts <participant_id>
```
* **Effect**: Subsequent token requests fail closed (`403 Forbidden`, `reason: "revoked"`).

### C. Participant Data Deletion
To delete a participant's state cleanly:
```bash
npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/delete-participant-data.ts <participant_id>
```
* **Effect**: State file `.maybesitter/participants/${participantId}-state.json` is deleted. Trust record is updated to `deletedAt`.

### D. Backup & Restore
```bash
# Create backup
npx ts-node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/backup-pilot-data.ts
```

---

## 4. Cost Estimate (25–40 Participants / Month)

* **Hosting (Cloud Run / Single Instance)**: ~$15 / month
* **Storage (Persistent Disk / S3 backups)**: ~$5 / month
* **LLM Provider API**: ~$30–$50 / month
* **Domain / WAF**: ~$5 / month
* **Total Estimated Cost**: **~$55 - $75 / month**
