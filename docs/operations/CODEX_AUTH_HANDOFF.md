# Codex Handoff Specification — Mobile API Authentication & Scope Binding Contract

**Lanes**: Codex (Backend API Port owner) $\leftrightarrow$ Operational Infra Lane  
**Date**: August 9, 2026  
**Status**: `SPECIFIED — AWAITING CODEX INTEGRATION`  

---

## 1. Objective

To complete pilot security readiness, all `/api/mobile/**` endpoints must enforce Bearer token authentication using the provided token primitive (`lib/pilot/pilotTokenService.ts`).

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

1. **Extract Token**: Inspect `Authorization: Bearer <token>`. Fail closed (`401 Unauthorized` / `403 Forbidden`) if missing, malformed, invalid, or revoked.
2. **Server Scope Binding**: Derive `participantId` strictly from `validation.participantId`. 
   * **DO NOT** accept or rely on client-supplied `scopeId` parameters in JSON body or URL parameters.
   * If a client passes `scopeId` in body, override it server-side: `scopeId = authenticatedParticipantId`.
3. **State Selection**: Use `authenticatedParticipantId` to load/persist the participant's state file (e.g. `.maybesitter/participants/${authenticatedParticipantId}-state.json`).
4. **Single-Instance Restriction Removal**: Update `resolvePilotAccess()` to validate allowlist and trust state per `participantId` dynamically, without enforcing a single global `MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID`.

---

## 4. Required Request-Level Test Suite (Codex Acceptance Contract)

Codex must satisfy the following 8 request-level HTTP route tests:

1. `NO_AUTH_HEADER`: Request without `Authorization` header $\rightarrow$ `401 Unauthorized`.
2. `MALFORMED_TOKEN`: Request with bad format $\rightarrow$ `401 Unauthorized`.
3. `FORGED_SIGNATURE`: Request with tampered signature $\rightarrow$ `401 Unauthorized`.
4. `VALID_A_TOKEN`: Request with valid Participant A token $\rightarrow$ `200 OK`.
5. `CROSS_TENANT_ACCESS`: Valid B token requesting Participant A commitment ID $\rightarrow$ `404 Not Found`.
6. `SCOPE_OVERRIDE_PREVENTION`: Valid B token passing `scopeId = "p-100"` in JSON body $\rightarrow$ Operation executes inside Participant B scope (`p-101`).
7. `REVOKED_TOKEN`: Valid token for revoked participant $\rightarrow$ `403 Forbidden` (`reason: 'revoked'`).
8. `DELETED_PARTICIPANT`: Valid token for deleted participant $\rightarrow$ `403 Forbidden` (`reason: 'deleted'`).
