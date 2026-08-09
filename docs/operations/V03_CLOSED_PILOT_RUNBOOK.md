# V03 closed-pilot trust and exposure notes

Issue: #55. Operational and trust-incident owner: **Anas Akkari**.

This document is retained for trust, consent, and incident-response context.
Architecture, deployment, backup, restore, token issuance, revoke/delete,
restart, and rollback procedures are superseded by the authoritative runbook:

`docs/operations/V03_PILOT_OPERATIONAL_DEPLOYMENT.md`

The canonical architecture is now a Flutter participant app using an OS-secure
pilot token, `Authorization: Bearer <token>`, a shared authenticated
`/api/mobile/**` backend, server-derived participant identity, and
participant-scoped persisted state. The older per-participant runtime,
`/assistant?pilotId=...`, client/browser-selected participant identity, and
`MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID` instructions are historical only and
must not be used for V03-P1 operations.

## Admission

The pilot is closed to 25-40 qualified, adult, separately consented
participants. Configure pseudonymous participant IDs in
`MAYBESITTER_CLOSED_PILOT_IDS`; the parser rejects fewer than 25, more than 40,
duplicates, direct identifiers, and malformed IDs. General-public exposure is
prohibited.

Recommendation exposure additionally requires the V02 feature flag enabled, the
recommendation kill switch inactive, explicit recommendation consent, quiet mode
off, and no revocation/deletion record. A denial at any layer fails closed.

## Progressive Disclosure

1. Manual input is the only initial capture path.
2. Explain the narrow recommendation and request recommendation consent.
3. Request analytics consent separately; refusal does not block product use.
4. Calendar consent is unavailable until a first-value event is recorded.
5. Private-message ingestion is unavailable and must not be added during V03.

No medical, therapeutic, diagnostic, guilt-based, or autonomous-life-management
claims are permitted in recruitment, consent, product copy, or support.

## User Controls

The visible "What MaybeSitter knows" view is limited to confirmed commitment
count and explicit consent/connection state. It always states that
private-message ingestion, sensitive inference, and medical profiling are off.

Quiet mode immediately blocks recommendation exposure without deleting
commitments. Revocation disables recommendation, analytics, and calendar consent
and preserves canonical commitments for export/deletion choice. Deletion is
final and invokes participant-local canonical-state and analytics deletion
paths. Consent must never be inferred from feature use.

Trust state, audit events, and incidents are stored atomically in a mode-`0600`
file selected by `MAYBESITTER_PILOT_TRUST_FILE`, normally under the durable
`MAYBESITTER_DATA_DIR`. Back up that file through the authoritative backup
procedure. Do not commit it.

## Stop Without Data Loss

For reliability, privacy, or safety incidents, activate
`MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`. This stops recommendations while
Capture and existing canonical commitments remain available. Do not clear
commitments as part of a pilot stop. Record a privacy-safe incident ID, time,
affected surface, severity, owner, containment action, and resolution; never
copy raw user input into the incident record.

Participants can create a coded incident from the trust panel. Operators read
the audit/incident log with `GET /api/pilot/incidents` and update
containment/resolution with `PATCH /api/pilot/incidents`; both operator calls
require `Authorization: Bearer <MAYBESITTER_PILOT_ADMIN_TOKEN>`. Set a random
token of at least 16 bytes and set `MAYBESITTER_PILOT_INCIDENT_OWNER_ID` to the
on-call pseudonymous owner code.

## Auditing and Review

Audit allowlist decisions, consent changes, quiet-mode changes, revocation, and
deletion using pseudonymous IDs and reason codes only. Before pilot activation,
verify 25-40 allowlisted participants, `MAYBESITTER_FEATURE_RECOMMENDATION=true`,
`MAYBESITTER_KILL_SWITCH_RECOMMENDATION=false`, consent copy, data
export/deletion, quiet mode, support escalation, protected durable trust-store
path, a strong admin token, and the owner on call. Real incident and exposure
records remain outside Git in the approved operational system.

