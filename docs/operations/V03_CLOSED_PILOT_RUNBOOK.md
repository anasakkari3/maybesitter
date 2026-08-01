# V03 closed-pilot trust and exposure runbook

Issue: #55. Operational and trust-incident owner: **Anas Akkari**. Status: technical controls implemented; no pilot exposure is authorized until the activation checklist and real-participant consent are complete.

## Admission

The pilot is closed to 25–40 qualified, adult, separately consented participants. Configure pseudonymous participant IDs in `MAYBESITTER_CLOSED_PILOT_IDS`; the parser rejects fewer than 25, more than 40, duplicates, direct identifiers, and malformed IDs. General-public exposure is prohibited.

Recommendation exposure additionally requires the V02 feature flag enabled, the recommendation kill switch inactive, explicit recommendation consent, quiet mode off, and no revocation/deletion record. A denial at any layer fails closed.

The current application storage is single-user. Deploy one isolated runtime and data directory per participant; a shared multi-participant runtime is prohibited. Each runtime must set `MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID` to exactly one ID from the 25–40-person cohort allowlist. Requests using any other allowlisted ID fail closed, preventing cross-participant state exposure.

Distribute each isolated instance as `https://<participant-specific-pilot-host>/assistant?pilotId=<pseudonymous-id>`. The client retains only that pseudonymous ID. Use random, non-guessable IDs in the real allowlist; the sequential IDs in automated tests are fixtures only.

## Progressive disclosure

1. Manual input is the only initial capture path.
2. Explain the narrow recommendation and request recommendation consent.
3. Request analytics consent separately; refusal does not block product use.
4. Calendar consent is unavailable until a first-value event is recorded.
5. Private-message ingestion is unavailable and must not be added during V03.

No medical, therapeutic, diagnostic, guilt-based, or autonomous-life-management claims are permitted in recruitment, consent, product copy, or support.

## User controls

The visible “What MaybeSitter knows” view is limited to confirmed commitment count and explicit consent/connection state. It always states that private-message ingestion, sensitive inference, and medical profiling are off.

Quiet mode immediately blocks recommendation exposure without deleting commitments. Revocation disables recommendation, analytics, and calendar consent and preserves canonical commitments for export/deletion choice. Deletion is final and must invoke canonical-state and analytics deletion paths. Consent must never be inferred from feature use.

Trust state, audit events, and incidents are stored atomically in a mode-`0600` file selected by `MAYBESITTER_PILOT_TRUST_FILE` (default `.maybesitter/pilot-trust.json`). Back up that file with the same controls as other pseudonymous participant data. Do not commit it.

## Stop without data loss

For reliability, privacy, or safety incidents, activate `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`. This stops recommendations while Capture and existing canonical commitments remain available. Do not clear commitments as part of a pilot stop. Record a privacy-safe incident ID, time, affected surface, severity, owner, containment action, and resolution; never copy raw user input into the log.

Participants can create a coded incident from the trust panel. Operators read the audit/incident log with `GET /api/pilot/incidents` and update containment/resolution with `PATCH /api/pilot/incidents`; both operator calls require `Authorization: Bearer <MAYBESITTER_PILOT_ADMIN_TOKEN>`. Set a random token of at least 16 bytes and set `MAYBESITTER_PILOT_INCIDENT_OWNER_ID` to the on-call pseudonymous owner code.

## Auditing and review

Audit allowlist decisions, consent changes, quiet-mode changes, revocation, and deletion using pseudonymous IDs and reason codes only. Before pilot activation, verify 25–40 allowlisted participants, a distinct `MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID` and isolated data directory on every runtime, `MAYBESITTER_FEATURE_RECOMMENDATION=true`, `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false`, consent copy, data export/deletion, quiet mode, support escalation, a protected trust-store path, a strong admin token, and the owner on call. Real incident and exposure records remain outside Git in the approved operational system.
