# V03 closed-pilot trust and exposure notes

Issue: #55. Operational and trust-incident owner: **Anas Akkari**.

This document is retained for trust, consent, and incident-response context.
Architecture, deployment, backup, restore, token issuance, revoke/delete,
restart, and rollback procedures are superseded by the authoritative runbook:

`docs/operations/V03_PILOT_OPERATIONAL_DEPLOYMENT.md`

The canonical architecture is now a React Native participant app using an OS-secure
pilot token, `Authorization: Bearer <token>`, a shared authenticated
`/api/mobile/**` backend, server-derived participant identity, and
participant-scoped persisted state. The older per-participant runtime,
`/assistant?pilotId=...`, client/browser-selected participant identity, and
`MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID` instructions are historical only and
must not be used for V03-P1 operations.

## Admission

Superseded by UC-1.0e (#144): there is no participant allowlist and no
environment variable that configures one. Anyone who signs in with Apple,
Google or email is a user, and the server derives their identity from a
Firebase ID token. Cohort size is now a *staging* concern rather than an
admission one — `SHADOW_STAGE_PARTICIPANT_CAP` and `_FLOOR` in
`src/contracts/v1/shadowPipelineContracts` still bound a closed-pilot stage to
25-40 people, and `lib/release/exposure` enforces it.

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
Capture and existing canonical commitments remain available.

### How to flip it (UC-2.9, #170)

`infra/cloudrun/flags.sh` sets the variable to `false` on both services, so it
is already present and the switch is a value change rather than a new variable
added under pressure:

```
gcloud run services update maybesitter-<env> --region europe-west1 \
  --update-env-vars MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true
```

It takes effect on the next request — `readRuntimeControls` is read per call,
not cached at boot — so no redeploy and no restart is needed. Reverse it with
`=false`.

What it does and does not do:

- `resolveNextStepAccess` answers `kill_switch_active`. The read route
  (`GET /api/mobile/recommendations/next-step`) returns **200 with no card** and
  `exposure: { allowed: false, reason: 'kill_switch_active' }`, so the home
  screen simply has no suggestion on it — it used to return 403, which drew
  "something went wrong" with a Retry button for every user during the incident
  (#170). The action route still returns **403**: the switch is thrown to stop
  this feature writing, and a recorded decision is a write. Nothing is deleted
  and no commitment changes.
- It does **not** stop capture, the lists, reminders, or anything a user has
  already saved. It stops the product making suggestions.
- Decisions already recorded in `nextStepDecisions` stay. A user who deferred
  something still has that deferral when the switch goes back off.

Two neighbouring variables, for the same incident:

- `MAYBESITTER_FEATURE_RECOMMENDATION=false` turns the feature off in the same
  way but reads as "not shipped here" rather than "stopped". Prefer the kill
  switch for an incident, so the audit log records `kill_switch_active` and the
  reason is legible afterwards.
- `MAYBESITTER_NEXT_STEP_ARM` pins which arm serves while no experiment runs
  (`personalized` in both environments). Setting it to `generic` is the
  narrower response when the problem is the personalization rather than the
  feature: it drops to the reviewed baseline ordering without taking the next
  step away from anyone. Do not clear
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

