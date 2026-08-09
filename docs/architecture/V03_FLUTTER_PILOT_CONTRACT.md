# V03 Flutter pilot contract — what the mobile client needs from `/api/mobile/**`

Owner of this document: the Flutter lane (V03-P1B).
Owner of the implementation it describes: the backend lane (V03-P1A).

The Flutter participant surface for issue #55 is implemented and tested against
this contract. **Neither endpoint exists yet.** Until they do, the client runs
against in-memory doubles (`lib/services/mock/`) and the real path is unexercised.

Nothing here is new invention. Both endpoints are thin, participant-bound
wrappers over handlers that already exist on `main`, and both response bodies
are the **unchanged** shapes those handlers already return:

| Mobile endpoint | Existing handler | Response body |
| --- | --- | --- |
| `/api/mobile/recommendation` | `src/app/api/next-step/route.ts` | `NextStepRecommendationContract` / `NextStepDecisionContract` |
| `/api/mobile/trust` | `src/app/api/pilot/trust/route.ts` | `{ trust, exposure, whatKnows }` |

Per `AGENTS.md`, Flutter talks only to `/api/mobile/**`; it must not call the
web routes directly, which is the only reason wrappers are needed at all.

---

## 1. `GET /api/mobile/recommendation`

```
GET /api/mobile/recommendation?participantId=<pseudonymous>&locale=<en|ar|he>
```

`participantId` maps to the existing handler's `anonymousUserId`. The client has
no other identity: no account, no token, no contact detail.

**200** — body is `NextStepRecommendationContract` verbatim:

```json
{
  "version": "1.0.0",
  "proposalId": "…",
  "state": "ready | empty | insufficient_evidence",
  "locale": "en",
  "primaryStep": { "commitmentId": "…", "title": "…" },
  "explanation": {
    "summary": "…",
    "evidenceLabels": ["due_today", "confirmed_by_you"],
    "sensitiveInferenceUsed": false
  },
  "availableActions": ["accept", "edit", "defer", "dismiss", "done"],
  "persistence": { "occurred": false, "confirmationRequired": true }
}
```

**403** — exposure refused. Must carry a machine-readable reason:

```json
{ "error": "closed pilot recommendation unavailable", "reason": "kill_switch_active" }
```

The existing handler already returns `reason`; keep it.

### Client behaviour worth knowing

- `state: "ready"` with a null `primaryStep` is treated as **not** actionable.
- `persistence.occurred` drives the "nothing has been changed yet" line the
  participant sees. It is read from the response, not hardcoded, so if the
  backend ever did persist, the UI would stop claiming it had not.
- `evidenceLabels` are localised against a closed vocabulary
  (`due_today`, `overdue`, `confirmed_by_you`, `high_priority`,
  `scheduled_soon`, `only_open_item`). Unknown codes collapse into one generic
  line and are never rendered raw — **do not put user text in this field.**
- No arm, variant or bucket field may be added to this response. Assignment
  stays backend-owned and invisible; a client test asserts none leaks to screen.

## 2. `POST /api/mobile/recommendation`

```json
{
  "participantId": "…",
  "locale": "en",
  "decision": "accept | edit | defer | dismiss | done",
  "editedTitle": "… (only when decision = edit)",
  "proposal": { "proposalId": "…", "state": "…", "locale": "…",
                "primaryStep": {…}, "availableActions": [...],
                "persistence": {…} }
}
```

The proposal is echoed so the server can re-derive its canonical proposal and
reject a decision aimed at a step the participant is no longer looking at.

- **200** — `NextStepDecisionContract`.
- **409** — stale/invalid proposal. The client surfaces a short notice and
  reloads rather than retrying.
- **403** — same shape as above.

## 3. `GET /api/mobile/trust`

```
GET /api/mobile/trust?participantId=<pseudonymous>
```

**200** — `{ trust, exposure, whatKnows }`, unchanged from `/api/pilot/trust`.

## 4. `POST /api/mobile/trust`

```json
{ "participantId": "…", "action": { "type": "…", … } }
```

Accepted actions, exactly as the existing handler's `ClientAction` union:

| Action | Extra field |
| --- | --- |
| `grant_recommendation_consent` | — |
| `set_analytics_consent` | `granted: boolean` |
| `set_calendar_consent` | `granted: boolean` |
| `set_quiet_mode` | `enabled: boolean` |
| `revoke` | — |
| `delete` | — |

`record_first_value` is deliberately **not** client-callable. First value is
something the server observes when it actually serves a ready proposal.

---

## Required contract change: a `suspended` stop reason

`PilotStopReason` currently has no way to express **operator-initiated removal
of an authorised participant**, and V03-P1B requires that state as distinct
from the others:

| State | Existing reason | Meaning to the participant |
| --- | --- | --- |
| never admitted | `not_allowlisted` | "This device isn't in the pilot" |
| chose to stop | `revoked` | "You turned suggestions off" — reversible by them |
| **removed by an operator** | **missing** | "Your pilot access is paused" — not theirs to undo |

Conflating suspension with `not_allowlisted` tells a real participant they were
never in the study. Conflating it with `revoked` tells them they did it
themselves and offers a re-enable button that will fail.

**Request:** add `'suspended'` to `PilotStopReason` in
`lib/pilot/closedPilotControls.ts` and emit it from `resolvePilotAccess` when an
operator has suspended an otherwise-allowlisted participant.

The Flutter client already handles `suspended` and has a passing test for it.
Until the backend emits it, that path is only exercised against the mock.

### How the client handles reasons it does not know

Any unrecognised `reason` string maps to `unknown` and is treated as **blocked**,
even if `allowed: true` came back alongside it. Adding a reason to the backend
without adding it here degrades safely to a neutral "suggestions are
unavailable" screen rather than either crashing or wrongly showing a proposal.
Tell this lane when a reason is added so it gets real copy.

---

## Fields the client relies on defaulting safely

The client's DTO layer defaults every ambiguous field to the cautious reading.
Backend changes should not rely on these defaults, but they define the failure
mode:

| Field | Missing/malformed reads as | Why |
| --- | --- | --- |
| `exposure.allowed` | `false` | Exposure fails closed |
| `trust.*Consent` | `false` | A missing field is never consent |
| `explanation.sensitiveInferenceUsed` | `true` | Never claim an absence the server did not state |
| `whatKnows.privateMessageIngestion` | `true` | Same |
| `whatKnows.sensitiveInference` | `true` | Same |
| `whatKnows.medicalProfile` | `true` | Same |
| `persistence.occurred` | `false` | Assume nothing was written |
| `persistence.confirmationRequired` | `true` | Assume confirmation is still needed |

## Not requested, and deliberately so

- No calendar read/write endpoint. V03 exposes calendar **consent** only; the
  UI does not offer it until `firstValueAt` is set, and no calendar data is
  fetched.
- No memory, priority, planning, decomposition or coaching endpoints. Stage B
  stays locked behind #61.
- No message-ingestion endpoint of any kind.
- No endpoint that would let the client assert first value, consent-by-usage, or
  its own qualification.
