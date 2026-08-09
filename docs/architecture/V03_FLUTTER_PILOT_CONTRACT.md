# V03 Flutter Pilot Contract

Owner of this document: Flutter integration lane for PR #83.
Canonical backend source: `main` at `740376395a5498841d81aef9073761f83d1a3628`.

## Status

Flutter PR #83 is wired to the canonical V03 mobile pilot backend contract from
PR #82. The PR remains Draft and is not deployed.

## Identity

Pilot identity is only:

```http
Authorization: Bearer <pilot-token>
```

The app stores the issued token in OS secure storage through
`PilotCredentialStore`. Tests use an in-memory fake. Production code does not
use `PILOT_PARTICIPANT_ID`, `AppConfig.participantId`, query `participantId`,
body `participantId`, or `scopeId` as participant security identity.

Backend-returned `participantId` may be displayed in "What MaybeSitter knows"
as informational pilot metadata. It is never selected by the client.

## Bootstrap

Real backend mode does not boot into Today until the token has been read and
validated with authenticated `GET /api/mobile/pilot/trust`.

Session states:

- loading credential
- no credential
- validating
- authorized
- unauthorized / invalid token
- not allowlisted
- revoked
- deleted
- backend unavailable
- invalid pilot runtime configuration

Invalid tokens are removed after failed token entry. `503
invalid_pilot_runtime_configuration` does not delete the stored credential.
Successful pilot deletion clears the secure token and transitions to a deleted
terminal session. Full revoke is terminal in the participant app; Suggestions
ON/OFF is not modeled as clearing `revokedAt`.

## Endpoints

| Flow | Method | Path |
| --- | --- | --- |
| Recommendation proposal | `GET` | `/api/mobile/recommendations/next-step` |
| Recommendation action | `POST` | `/api/mobile/recommendations/next-step/actions` |
| Trust snapshot | `GET` | `/api/mobile/pilot/trust` |
| Trust action | `POST` | `/api/mobile/pilot/trust` |

Existing capture and commitment routes remain unchanged, with authorization
handled centrally by `ApiClient` in real backend mode.

## Recommendation Proposal

Request:

```http
GET /api/mobile/recommendations/next-step?locale=en&timezone=UTC
Authorization: Bearer <pilot-token>
```

Flutter sends locale and, where needed, timezone. It does not send
`participantId`, `scopeId`, arm, variant, or experiment metadata.

Response envelope:

```json
{
  "success": true,
  "participantId": "pseudonymous-id",
  "recommendation": {
    "version": "1.0.0",
    "proposalId": "proposal-123",
    "state": "ready",
    "locale": "en",
    "primaryStep": { "commitmentId": "c-1", "title": "Call Maya" },
    "explanation": {
      "summary": "Due today",
      "evidenceLabels": ["due_today", "confirmed_by_you"],
      "sensitiveInferenceUsed": false
    },
    "availableActions": ["accept", "edit", "defer", "dismiss", "done"],
    "persistence": { "occurred": false, "confirmationRequired": true }
  },
  "assignment": {},
  "exposure": { "allowed": true, "reason": "authorized" }
}
```

Flutter consumes `recommendation` and exposure reason only. Assignment remains
backend-owned and invisible to participants.

## Recommendation Action

Request:

```json
{
  "locale": "en",
  "decision": "accept",
  "idempotencyKey": "stable-logical-action-key",
  "proposal": { "proposalId": "proposal-123" }
}
```

`editedTitle` is included only for edit decisions. The same logical retry
reuses its idempotency key; a new deliberate decision gets a new key.

Response envelope:

```json
{
  "success": true,
  "replayed": false,
  "participantId": "pseudonymous-id",
  "assignment": {},
  "outcome": {
    "version": "1.0.0",
    "proposalId": "proposal-123",
    "decision": "accept",
    "decidedAt": "2026-08-09T10:00:00.000Z"
  }
}
```

HTTP `409` is stale proposal or idempotency mismatch; Flutter reloads rather
than retrying blindly.

## Trust

Request:

```http
GET /api/mobile/pilot/trust
Authorization: Bearer <pilot-token>
```

`POST /api/mobile/pilot/trust` sends:

```json
{ "action": { "type": "set_recommendation_consent", "granted": false } }
```

Accepted actions:

| Action | Meaning |
| --- | --- |
| `grant_recommendation_consent` | grant recommendation consent |
| `set_recommendation_consent` | Suggestions ON/OFF only |
| `set_analytics_consent` | usage-data consent only |
| `set_calendar_consent` | calendar consent only |
| `set_quiet_mode` | hide/show recommendation surface |
| `revoke` | terminal full revoke, commitments preserved |
| `delete` | terminal participant-local deletion |

`record_first_value` is not client-callable. The backend records first value
when it serves a ready recommendation.

## HTTP Handling

| Status | Flutter behavior |
| --- | --- |
| `401 missing_token`, `malformed_token`, `invalid_signature` | unauthenticated or invalid token state |
| `403 not_allowlisted`, `revoked`, `deleted` | participant-visible pilot state |
| `403 consent_required`, `quiet_mode`, `feature_disabled`, `kill_switch_active` | recommendation blocked, app remains token-authorized |
| `409` | stale recommendation or idempotency mismatch; reload |
| `503 invalid_pilot_runtime_configuration` | operator configuration fault, credential preserved |
| network failure | backend unavailable, distinct from invalid token |

The Flutter model keeps a forward-compatible `suspended` reason for display,
but canonical PR #82 does not currently emit it. Unknown reasons fail closed.
