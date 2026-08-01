# V03 closed-pilot trust and exposure runbook

Issue: #55. Operational and trust-incident owner: **Anas Akkari**. Status: implementation foundation; no pilot exposure is authorized by this document.

## Admission

The pilot is closed to 25–40 qualified, adult, separately consented participants. Configure pseudonymous participant IDs in `MAYBESITTER_CLOSED_PILOT_IDS`; the parser rejects fewer than 25, more than 40, duplicates, direct identifiers, and malformed IDs. General-public exposure is prohibited.

Recommendation exposure additionally requires the V02 feature flag enabled, the recommendation kill switch inactive, explicit recommendation consent, quiet mode off, and no revocation/deletion record. A denial at any layer fails closed.

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

## Stop without data loss

For reliability, privacy, or safety incidents, activate `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true`. This stops recommendations while Capture and existing canonical commitments remain available. Do not clear commitments as part of a pilot stop. Record a privacy-safe incident ID, time, affected surface, severity, owner, containment action, and resolution; never copy raw user input into the log.

## Auditing and review

Audit allowlist decisions, consent changes, quiet-mode changes, revocation, and deletion using pseudonymous IDs and reason codes only. Before pilot activation, verify 25–40 allowlisted participants, feature/kill-switch state, consent copy, data export/deletion, quiet mode, support escalation, and the owner on call. Real incident and exposure records remain outside Git in the approved operational system.
