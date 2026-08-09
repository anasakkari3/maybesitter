# Codex Handoff Specification — Mobile API Authentication & Scope Binding Contract

**Lanes**: Codex (Backend API Port owner) $\leftrightarrow$ Operational Infra Lane  
**Date**: August 9, 2026  
**Status**: `IMPLEMENTED IN PR #82 — SHARED PILOT MOBILE ROUTES AUTHENTICATED`

---

## 1. Objective

To complete pilot security readiness, pilot-enabled `/api/mobile/**` endpoints enforce Bearer token authentication using the provided token primitive (`lib/pilot/pilotTokenService.ts`). When pilot auth is configured, existing capture/commitment routes derive participant state from the token; recommendation, trust, and incident routes always require the token.

---

## 2. Token Primitive API

Codex can import and invoke `parseAndValidatePilotToken`:

```typescript
import { parseAndValidatePilotToken } from '@/lib/pilot/pilotTokenService';

// Extract Authorization header
const authHeader = request.headers.get('Authorization'); // "Bearer p-token.<participant_id>.<nonce>.<sig>"
const validation = parseAndValidatePilotToken(authHeader);

if (!validation.valid) {
  return Response.json(
    { error: validation.reason ?? 'unauthorized' },
    { status: validation.reason === 'revoked' ? 403 : 401 }
  );
}

const authenticatedParticipantId = validation.participantId!;
```

---

## 3. Required Server Behavior

1. **Extract Token**: Inspect `Authorization: Bearer <token>`. Fail closed (`401 Unauthorized` / `403 Forbidden`) if missing, malformed, invalid, non-allowlisted, revoked, or deleted.
2. **Server Scope Binding**: Derive `participantId` strictly from `validation.participantId`. 
   * **DO NOT** accept or rely on client-supplied `scopeId` parameters in JSON body or URL parameters.
   * If a client passes `scopeId` in body, override it server-side: `scopeId = authenticatedParticipantId`.
3. **State Selection**: Use `authenticatedParticipantId` to load/persist the participant's state file (e.g. `.maybesitter/participants/${authenticatedParticipantId}-state.json`) via the participant-scoped adapter in `lib/services/mobile/participantState.ts`.
4. **Shared Runtime**: `resolvePilotAccess()` validates allowlist and trust state per `participantId` dynamically and does not enforce a single global `MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID`.
5. **Concurrency**: Participant state writes are serialized by participant key around load -> canonical `applyDomainCommand()` -> atomic file rename. Different participants use independent queues.
6. **Deletion**: Participant deletion marks trust deleted and removes only that participant's domain/idempotency state.

---

## 4. Required Request-Level Test Suite (Codex Acceptance Contract)

Codex satisfies the following request-level HTTP route tests:

1. `NO_AUTH_HEADER`: Request without `Authorization` header $\rightarrow$ `401 Unauthorized`.
2. `MALFORMED_TOKEN`: Request with bad format $\rightarrow$ `401 Unauthorized`.
3. `FORGED_SIGNATURE`: Request with tampered signature $\rightarrow$ `401 Unauthorized`.
4. `VALID_A_TOKEN`: Request with valid Participant A token $\rightarrow$ `200 OK`.
5. `CROSS_TENANT_ACCESS`: Valid B token requesting Participant A commitment ID $\rightarrow$ `404 Not Found`.
6. `SCOPE_OVERRIDE_PREVENTION`: Valid B token passing `scopeId = "p-100"` in JSON body $\rightarrow$ Operation executes inside Participant B scope (`p-101`).
7. `REVOKED_TOKEN`: Valid token for revoked participant $\rightarrow$ `403 Forbidden` (`reason: 'revoked'`).
8. `DELETED_PARTICIPANT`: Valid token for deleted participant $\rightarrow$ `403 Forbidden` (`reason: 'deleted'`).
9. `QUERY_BODY_SPOOFING`: Authenticated B with `participantId/scopeId = A` remains in B scope.
10. `LOCAL_DELETE`: Deleting A leaves B's commitments and trust state intact.
11. `CONCURRENT_WRITES`: Concurrent A/B and same-participant writes do not lose updates.
