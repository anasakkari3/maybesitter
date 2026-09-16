# Firestore data model

Owner: UC-1.0b (#141). Extended by UC-1.0c (#142) as the remaining stores move.

Everything a user owns lives under one document, `users/{uid}`, so deleting an
account is one `deleteTree` and no store can be forgotten. Nothing outside that
tree is keyed by a person, with one deliberate exception: `incidents/`, which is
operator-only.

## Paths

| Path | Holds | Written by |
| --- | --- | --- |
| `users/{uid}` | `{ schemaVersion: 1, createdAt, updatedAt, locale: 'ar'\|'he'\|'en'\|null, timezone: string\|null, trust, domainVersion: number }` | `lib/services/mobile/participantState.ts`, `lib/pilot/pilotTrustStore.ts` |
| `users/{uid}/commitments/{commitmentId}` | `Commitment` (`src/domain/stateMachine`) | `participantState.ts` |
| `users/{uid}/reminders/{reminderId}` | `Reminder` | `participantState.ts` |
| `users/{uid}/escalationStates/{commitmentId}` | `EscalationState` | `participantState.ts` |
| `users/{uid}/events/{eventId}` | `DomainEvent & { recordedAt }` — append-only, written only with `create` | `participantState.ts` |
| `users/{uid}/recommendationActions/{sha256(idempotencyKey)}` | `{ idempotencyKey, fingerprint, response, createdAt }` | `participantState.ts` |
| `users/{uid}/commitmentActionReceipts/{clientActionId}` | `{ clientActionId, commitmentId, fingerprint, result, createdAt, expiresAt }` — one per notification tap applied, so an outbox replay is applied once (#200); TTL 30 days | `participantState.ts` |
| `users/{uid}/auditEvents/{sortableId}` | `PilotAuditEvent` | `pilotTrustStore.ts` |
| `incidents/{incidentId}` | `PilotTrustIncident` — operator-only, outside every user tree | `pilotTrustStore.ts` |

`trust` on the user document is the `PilotTrustState` from
`lib/pilot/closedPilotControls`: `{ recommendationConsent, analyticsConsent,
calendarConsent, firstValueAt, quietMode, revokedAt, deletedAt, updatedAt }`,
plus the `version` and `participantId` that record validates itself against.

## Decisions

**One document per entry, not one `DomainState` document.** A single document
holding every commitment would eventually hit Firestore's 1 MiB limit, and
every write would rewrite the whole account. Per-entry documents also make a
transaction's write set proportional to the command.

**`domainVersion` is incremented once per committed domain transaction.** It is
what tells "twenty writes landed" apart from "twenty writes raced and four were
lost". The old file-based store had no such number, which is why the lost-write
bug was invisible.

**Document ids derived from free text are `sha256` hex, with the raw value in a
field.** An idempotency key is caller-supplied: it can contain `/`, exceed the
id length limit, or be `__proto__`. Hashing makes the path a path; the field
keeps the record findable and auditable.

**User ids match `/^[A-Za-z0-9_-]{1,128}$/`** (`lib/storage/paths.ts`). Pilot
ids are lowercase by their own contract, but a Firebase uid is mixed-case, so
the path-level check accepts both. Admission is still
`requirePilotParticipantId`'s decision — this one only rejects what breaks a
path.

**Audit ids sort by time** (`<occurredAt>_<uuid>`, punctuation flattened), so a
plain listing returns the log in order with no index and no `orderBy`.

**Clients never write.** `firestore.rules` allows a signed-in client to read
its own tree — for future realtime and offline use — and denies every client
write everywhere. All writes go through the API, where validation lives; the
Admin SDK bypasses rules. Models propose, rules validate.

## What is *not* here yet

UC-1.0c (#142) moves `RuntimeMemoryRepository`, `FeedbackRepository`,
`AlphaTraceStore` and `SchedulerStore`. Those still write files under
`MAYBESITTER_DATA_DIR`, so a Cloud Run deployment is not yet free of local
state. UC-1.0e (#144) replaces the pilot bearer token with Firebase auth, at
which point `request.auth.uid` in the rules and `{uid}` in these paths become
the same identity for a real signed-in user.
