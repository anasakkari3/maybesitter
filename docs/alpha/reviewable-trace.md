# Alpha Interaction Trace — Pre-Pilot Reviewable Trace

> **Purpose:** make meaningful AI decisions reviewable after the fact during the
> pre-pilot alpha phase. This is internal observability for dogfooding, not a
> product feature and not permanent analytics.

## What is recorded

For each relevant session, the trace reconstructs:

| Stage | Content |
|---|---|
| `input_received` | The user's capture text (bounded to 2,000 chars) |
| `extraction_completed` | Extractor engine, type, title, disposition, times, confidence, fallback reason |
| `commitment_created` | commitmentId + title |
| `recommendation_generated` | proposalId, state, primary step title, arm assignment, latency |
| `proposal_decided` | decision (accept/edit/defer/dismiss/done); for `edit`, the original and edited title |
| `feedback_flagged` | flag category + note (from the feedback flag system) |

Each stage carries a timestamp. Traces are stored per session under
`.maybesitter/alpha-traces/<sessionId>.trace.json`.

## What is NOT recorded

- **No private messages are ingested.** Only text the user typed into the
  capture flow (and only when the alpha trace flag is enabled) is stored.
- **No analytics events are derived from traces.** Trace content never flows
  into `loopAnalytics` or any aggregation; it is review-only.
- **No raw content beyond the capture input and proposal titles.** The
  recommendation *context* is recorded as evidence labels and arm
  assignment, not as a full state dump.

## Consent and access controls

- Recording is **opt-in per environment**: `MAYBESITTER_ALPHA_TRACE_ENABLED=true`.
  Without the flag, all recorder calls are no-ops and the review endpoint
  returns `feature_disabled`.
- Pilot auth is required for every trace API call.
- **Access boundary:** a participant may read their own sessions; the owner
  (`MAYBESITTER_ALPHA_TRACE_OWNER_ID`) may read any session. No other role.
- The internal review endpoint is `GET /api/mobile/alpha/trace?sessionId=...`
  (one session) or `?withFeedbackOnly=true` (summaries).

## Retention and deletion

- **Bounded retention:** 30 days by default (`retentionTtlMs`).
  `store.prune()` removes expired sessions; run it from the review CLI or a
  scheduled job.
- **Deletion:** `deleteSession(sessionId)` and `deleteParticipant(participantId)`
  remove trace files. The pilot `delete-participant-data` flow should call
  `deleteParticipant` for each revoked participant.

## Review workflow

1. Dogfooder flags a recommendation via the feedback flag system
   (`recommendation_wrong`, `misunderstood_me`, `not_useful`, `invasive`,
   `technical_problem`).
2. Reviewer opens the session trace
   (`GET /api/mobile/alpha/trace?sessionId=...` or the local CLI) and
   reconstructs: input → interpretation → commitment → recommendation →
   decision → (optionally) edit before/after or flag.
3. Failures are classified against
   `docs/quality/ALPHA_QUALITY_TAXONOMY.md` (Lane C harness categories).

## Operations

- Enable: `MAYBESITTER_ALPHA_TRACE_ENABLED=true`
- Owner (can read all sessions): `MAYBESITTER_ALPHA_TRACE_OWNER_ID=<participantId>`
- Prune old traces: `node scripts/alpha-trace-prune.ts` (or call `prune()` from a job)
- Delete participant data: `deleteParticipant(participantId)` (also used by
  `scripts/delete-participant-data.ts`)

## Status

- [x] Contracts (`src/contracts/v1/alphaTraceContracts.ts`)
- [x] Store with retention/deletion/access (`lib/alphaTrace/alphaTraceStore.ts`)
- [x] Recorder facade + route instrumentation (capture, next-step, actions)
- [x] Review endpoint (`GET /api/mobile/alpha/trace`)
- [x] Tests (`tests/alphaTrace/alphaTraceStore.test.ts`)
- [ ] Review CLI polish (optional, beyond alpha)
- [ ] Scheduled prune job (recommended before external alpha)
