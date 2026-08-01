# V02 privacy-safe analytics

The v1 schema covers the complete narrow-loop event vocabulary from capture through recommendation decisions, reason opening, calendar consent, deletion, and pricing intent. Events contain anonymous identifiers, cohort/experiment assignment, timestamps, and event-specific scalar properties only.

Validation is strict: unknown top-level fields, event-inappropriate properties, raw-message-like keys, non-scalar values, long strings, invalid timestamps, and analytics events without consent are rejected. A deletion receipt is essential and may remain after the user's other analytics events are removed.

Reports compute unique-user activation, a fixed event funnel, Week-4 and Week-8 activity retention, calendar connection behavior, and deletion counts. The JSONL fixture is the reconciliation source for tests. Experiment assignment and ISO-week cohorts are deterministic.

## Where events are emitted

Every event is built through `lib/analytics/analyticsContext.ts`, which stamps the anonymous id, ISO-week cohort, and deterministic experiment arm, then validates the payload before it reaches the store. Emission is refused when consent is `essential`, except for `data_deleted`.

| Events | Emitted by |
| --- | --- |
| `capture_submitted`, `commitment_detected`, `commitment_confirmed` | `POST /api/capture`, derived from the domain state the capture produced |
| `commitment_edited` | `PATCH /api/commitment/[id]`, only when a field actually changed |
| `recommendation_shown`, `recommendation_accepted`/`edited`/`deferred`/`dismissed`/`completed` | `lib/services/nextStepLiveService.ts` via `/api/next-step` |
| `data_deleted` | `POST /api/commitments/clear`, and `POST /api/analytics` |
| `reason_opened`, `calendar_connect_started`, `calendar_connected`, `pricing_viewed`, `purchase_intent` | `POST /api/analytics` |

Loop-state events are derived server-side from committed domain state, so a client cannot forge activation or funnel progress. `POST /api/analytics` accepts only the surface events a client can legitimately observe (`CLIENT_REPORTABLE_EVENTS`); anything else is a 400.

Requests opt in by sending `anonymousUserId` and `consent`. Without an `anonymousUserId` collection is simply off — the product request still succeeds.

## Reports

`GET /api/analytics` returns the activation, funnel, retention, and consent report over recorded events. `npm run analytics:report -- --events <jsonl> --report <json> --at <iso>` writes the same report from an event file, revalidating every line before it counts; it defaults to the JSONL fixture and `evaluation-reports/v02-analytics-report.json`.

Migration is additive. Rollback stops accepting v1 events and removes the report builder; deletion processing must continue until all retained v1 data reaches its deletion/retention deadline.
