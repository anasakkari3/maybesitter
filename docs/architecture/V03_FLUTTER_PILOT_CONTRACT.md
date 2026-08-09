# V03 Flutter pilot contract — handoff

Owner of this document: the Flutter lane (V03-P1B).
Owner of the implementation it describes: the backend lane (V03-P1A / PR #82).

> **Status: HANDOFF, NOT INTEGRATED.**
>
> PR #83 (Flutter) is **not** wired to the real backend. It runs entirely against
> in-memory doubles in `mobile/lib/services/mock/`. The endpoints and identity
> model this client currently codes against are **obsolete** — superseded by
> PR #82. The integration work listed at the end of this document has **not**
> been done, and nothing here should be read as a claim that it has.

## Section 1 — OBSOLETE assumptions (what PR #83 currently implements)

Everything in "Superseded contract" below was written before PR #82 landed its
authenticated, participant-scoped mobile API. It is retained only so the next
agent can see exactly what has to change.

| Obsolete assumption in PR #83 | Superseded by |
| --- | --- |
| `GET/POST /api/mobile/recommendation` | `/api/mobile/recommendations/next-step` and `.../actions` |
| `GET/POST /api/mobile/trust` | `/api/mobile/pilot/trust` |
| `participantId` as a query parameter / body field = identity | `Authorization: Bearer <pilot-token>`; client-sent `participantId`/`scopeId` are **ignored** for scope selection |
| `AppConfig.participantId` from `--dart-define` is the participant identity | The token is the identity; the client must hold a credential, not an id |
| No 401 handling | 401 is a first-class state (missing/malformed/invalid token) |
| Two endpoints total | Capture and commitment routes are also bearer-authenticated in pilot mode |

## Section 2 — TARGET contract (PR #82, `v03/mobile-pilot-backend-parity`)

Not yet implemented in Flutter.

### Identity

```http
Authorization: Bearer p-token.<participant_id>.<nonce>.<signature>
```

- The **bearer token is the only participant identity.** `participantId` and
  `scopeId` are **not** security identity; the backend ignores them for
  storage and scope selection, and an authenticated client need not send them.
- Server-owned scope: the authenticated `participantId` selects participant
  state. There is no client-selectable scope.

### Endpoints

| Method | Path |
| --- | --- |
| `GET` | `/api/mobile/recommendations/next-step` |
| `POST` | `/api/mobile/recommendations/next-step/actions` |
| `GET` | `/api/mobile/pilot/trust` |
| `POST` | `/api/mobile/pilot/trust` |
| `POST` | `/api/mobile/pilot/incidents` |

Capture and commitment routes (`/api/mobile/capture`, `.../capture/confirm`,
`.../commitments/*`) are also bearer-authenticated when pilot mode is on.

### Status codes the client must handle

| Status | Meaning |
| --- | --- |
| `503 invalid_pilot_runtime_configuration` | pilot mode on, config invalid — fail closed |
| `401 missing_token` | pilot mode on, no `Authorization` |
| `401` | malformed token or invalid signature |
| `403` | non-allowlisted, revoked, or deleted participant |

The payload/DTO shapes are otherwise unchanged from the superseded contract
below, so the existing DTO layer in `mobile/lib/services/api/dtos/` should port
without rewriting.

---

## Superseded contract (retained for reference only)

Everything from here to the end of Section 3 describes the **old** endpoints.
Do not implement against it.

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
| `set_recommendation_consent` | `granted: boolean` — **not yet supported by the backend**, see below |
| `set_analytics_consent` | `granted: boolean` |
| `set_calendar_consent` | `granted: boolean` |
| `set_quiet_mode` | `enabled: boolean` |
| `revoke` | — |
| `delete` | — |

`record_first_value` is deliberately **not** client-callable. First value is
something the server observes when it actually serves a ready proposal.

---

## Section 3 — Remaining integration checklist (NOT DONE)

None of the following is implemented. Each is a separate, deliberate piece of
work for the next agent.

1. **Secure credential storage.** The client has no way to hold a bearer token.
   `AppConfig.participantId` is a `--dart-define` string, which is not a
   credential store. Needs a real secure store (Keychain / Keystore), a
   provisioning path for getting the token onto the device, and a wipe path on
   deletion and revocation.
2. **Bearer auth in `ApiClient`.** `ApiClient` sends no `Authorization` header
   and has no injection point for one. Every mobile route needs it, not just
   the two pilot routes.
3. **Endpoint paths.** `ApiNextStepService.recommendationPath` and
   `ApiPilotTrustService.trustPath` still point at the obsolete
   `/api/mobile/recommendation` and `/api/mobile/trust`.
4. **Response-envelope alignment.** The DTO layer was written against the old
   handlers' bodies. Confirm PR #82's envelope field-by-field before trusting
   the existing parsers.
5. **HTTP 401 / session handling.** `ApiClient` maps 401 to a generic
   `ServerException`. It needs a distinct unauthenticated state, and the UI
   needs to route it somewhere other than the generic offline notice.
6. **`503 invalid_pilot_runtime_configuration`.** Currently collapses into the
   generic server error. Should be a distinct, non-retryable operator-fault state.
7. **Bootstrap / session gate.** There is no app-level gate: the app boots
   straight into Today regardless of whether a valid session exists. Blocked
   pilot states surface only inside the Today card.
8. **Remove `participantId` from request payloads** once the token is the
   identity, so the client cannot appear to assert a scope it does not control.
9. **`set_recommendation_consent` backend support** — see below.
10. **`suspended` stop reason backend support** — see below.

## Required contract change: `set_recommendation_consent`

The trust centre's "Suggestions" switch sends:

```json
{ "type": "set_recommendation_consent", "granted": true | false }
```

**The backend does not accept this action yet.** The existing union offers only
`grant_recommendation_consent` (grant-only) and `revoke` (turns off
recommendation *and* analytics *and* calendar consent, and sets `revokedAt`).

PR #83 originally mapped the switch's OFF position onto `revoke`, which silently
withdrew analytics and calendar consent the participant had not asked to
withdraw. That is corrected in the Flutter client: the switch now sends the
narrow action, and full revoke remains a separate, confirmed button.

**Request:** add `set_recommendation_consent` with a boolean `granted` to the
trust action union. `granted: false` must clear recommendation consent only,
leaving `analyticsConsent`, `calendarConsent` and `revokedAt` untouched.

Until it lands, the narrow action is exercised only against the mock; a real
backend will reject it as an unsupported action type.

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
