# Decomposition proposal and confirmation boundary

Sprint 06, issue #25. Companion to `docs/architecture/capture-boundary.md`, which
established the shape this follows.

## Contract and ownership

Decomposition uses the versioned v1 contracts in
`src/contracts/v1/decompositionContracts.ts`. Engine output is untrusted and can
only produce a proposal. A proposal carries no persisted or applied field, and
no proposal type carries a mutation of the commitment it describes: decomposition
adds steps *beside* a commitment and never rewrites it.

Canonical writes belong only to an implementation of
`DecompositionPersistencePort`, which `lib/decomposition/proposal/persistencePort.ts`
declares and deliberately does not implement. The adapter that satisfies it is
#27's, and it is not production-routed in Sprint 06.

```text
commitment text
→ engine proposal (#27, untrusted)
→ entry validation at admission (shared violation vocabulary)
→ accept / edit / reject reducer, one explicit verdict per step
→ complete, well-formed confirmation request
→ injected persistence port
→ canonical state
```

| Concern | Where it lives |
|---|---|
| Pure reducer over proposal state | `lib/decomposition/proposal/proposalStateMachine.ts` |
| Entry validation | `validateProposalEntry` in the same file |
| Persistence seam (interface only) | `lib/decomposition/proposal/persistencePort.ts` |
| Store, scope check, idempotency | `lib/decomposition/proposal/proposalStore.ts` |

## The corrected premise: not a domain state transition

The issue's "accept/edit/reject state machine" reads as an extension of
`src/domain/stateMachine.ts`. It is not one, and deliberately.

`Commitment` there has no notion of a step or a parent, Sprint 07's scheduler
reads that type, and Sprint 06 has no production route. Extending `DomainState`
for a feature nobody can reach would push a schema change into a shared surface
for no live consumer. So the state machine is a **pure reducer over proposal-local
state**, `DomainState` is unchanged this sprint, and confirmed steps leave
through the injected port.

`tests/decomposition/proposalBoundaries.test.ts` bans `src/domain/stateMachine`
from the module's transitive import closure, so this decision cannot quietly
reverse itself in a later edit.

## Behaviour

### Silence is never consent

`decisions` must cover every step in the proposal exactly once.

- A missing verdict fails the request with `incomplete_decisions`. It is not
  treated as a rejection: an omitted step reads identically to a client that
  dropped one from its payload, and the user would then be told they declined
  something they never saw.
- A second verdict for a step fails with `duplicate_decision` rather than
  last-one-wins. Two verdicts mean the caller does not know what the user chose,
  and picking either invents an answer.
- A verdict naming a step outside the proposal fails with `unknown_step`.
- An `edit` whose title is blank or whitespace fails with `invalid_edit`.
- The **first** failure sticks and no decision applies. A fold that kept going
  could have a later entry repair the state an earlier malformed one produced,
  and the caller would be told its request succeeded while a step it named was
  discarded.

Rejecting every step is a valid, explicit outcome: it succeeds, persists
nothing, and never reaches the port.

### An edit moves the title, not the provenance

An edited step keeps its `sourceSpans` byte-for-byte, and the engine's original
wording travels alongside as `proposedTitle`. The user rewrote the words the
step is *stated* in; they did not claim it came from different words. Rewriting
spans to match a new title would silently break the property the whole
provenance design rests on, `sourceText.slice(start, end) === text`.

The stored proposal is never modified by a confirmation. An edit changes what is
confirmed, never what was proposed.

### Entry validation

Applied at admission, not only in the engine, because a proposal can reach a
store from more than one producer and the check that matters is made by whoever
is about to show it to a user. Codes come from `DecompositionViolationCode`;
this module invents none, because a private code would be one #26 could not
count and #27 could not reject.

| Code | Condition |
|---|---|
| `EMPTY_STEP` | Title blank, whitespace, or punctuation only |
| `CONJUNCTION_ONLY` | Title is only a connective — `and`, `then`, `و`, `ثم`, `ו`, `ואז` |
| `DUPLICATE_STEP_ID` | Two steps share a `stepId` |
| `SELF_DEPENDENCY` | A step depends on itself |
| `UNKNOWN_DEPENDENCY` | An edge points at no step in the proposal |
| `CYCLIC_DEPENDENCY` | The dependency graph is not acyclic (proposal-level, `stepId: null`) |

`CONJUNCTION_ONLY` matches the whole title only. Arabic and Hebrew write the
conjunction as a clitic prefixed onto the next word with no whitespace
(`واطلب`, `ותזמין`), so a splitter that strips the prefix emits the bare letter
as if it were a step — a one-character artefact that passes any "non-empty
title" check, which is why it is a separate code. A title that merely *starts*
with a connective is a real step and is admissible; rejecting those would break
exactly the golden rows the clitic handling exists to support.

Span exactness, invented timings and owners, and the atomic/do-not-split
judgement are **not** checked here. They need the source text and the label, they
belong to #27's validator and #26's evaluator, and duplicating them would create
the second opinion the shared vocabulary exists to prevent.

An inadmissible proposal is not stored, so it is not merely unconfirmable — it is
not offerable. A `rejected` proposal is refused admission carrying its own
violations rather than re-derived ones.

### Confirmation, scope and idempotency

- Confirmation is scope-checked. A mismatch reports `proposal_not_found` rather
  than "not yours", so a caller outside the scope does not learn the id exists.
- A replayed identical confirmation (same `idempotencyKey` **and** same
  decisions) returns `replayed: true` and does not call the port again.
- The confirmation is recorded only **after** the port returns. Recording first
  would make a failed write look like a completed one, and the retry that would
  have fixed it would be refused as a duplicate. A port that throws yields
  `persistence_failed` and leaves the proposal confirmable.
- The port receives the whole batch, never a step at a time. A per-step call lets
  a failure land halfway, leaving the user with three steps where they confirmed
  five and no record of which two are missing. An implementation applies the
  batch atomically or rejects it whole.
- The port is not called at all when nothing was confirmed. An empty batch is not
  a write with nothing in it; it is no write.

### Known contract gap

`ConfirmationFailureCode` has no `already_confirmed`. Two cases need it:

1. The same `idempotencyKey` replayed with **different** decisions. Returning the
   stored result would tell the caller its new decisions were applied when they
   were discarded.
2. A **new** key against an already-confirmed proposal — a second apply, which is
   the thing the confirmation boundary exists to prevent.

Both currently return `proposal_not_found`, which is accurate in the sense that
there is no *open* proposal left to confirm and is the least-wrong of the codes
that exist, but it is not the finding. `src/contracts/v1/decompositionContracts.ts`
is frozen shared surface for Sprint 06, so this is recorded here rather than
patched. Adding `already_confirmed` is a purely additive change to the union and
should be made before any consumer branches on the failure code.

## Failure and compatibility behaviour

- The reducer reads no clock and no random source, imports no I/O primitive, and
  has no writer in its transitive import closure. All four are checked by source
  scan in `tests/decomposition/proposalBoundaries.test.ts`, not asserted in a
  comment.
- Kill-switch behaviour follows the Sprint 00 runtime controls and lives with
  #27's engine: a disabled model path selects the rules detector and
  decomposition stays available. Nothing in this module reads a flag.
- This boundary is additive and is **not** enabled as a production route in
  Sprint 06. No existing behaviour changes.

## Migration

No stored-state migration is required.

- `DomainState` and `src/domain/stateMachine.ts` are unchanged.
- Proposals are not persisted as canonical state; the store is in-memory and
  per-process.
- There is no production consumer, so there is no traffic to migrate and no
  compatibility window to hold open.

Consumers may adopt the v1 decomposition contracts incrementally. Until one is
migrated, this boundary has no production traffic and alters no existing route.

## Rollback

Nothing was written to user data, so there is nothing in user data to undo.

1. Stop new consumers from calling `createInMemoryProposalStore`. There are none
   in Sprint 06; this step exists for the sprint that routes it.
2. Allow or reject already-issued proposals explicitly. In-flight proposals are
   in-memory and are lost on restart, which is a lost offer, never a lost or
   half-applied commitment — nothing reached canonical state without a completed
   confirmation.
3. Revert the focused #25 commit. `lib/decomposition/proposal/**`,
   `tests/decomposition/proposal*.test.ts` and this document are the whole
   surface; no shared file is touched.

No canonical-state rollback is required, because proposal creation writes nothing
and confirmation writes only through an injected port that Sprint 06 ships no
implementation of.

Verify a rollback by running the boundary suite and confirming a domain state
snapshot is byte-identical before and after an unconfirmed — and a confirmed —
proposal.

## Tests

```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/decomposition/proposal*.test.ts
```

| File | Covers |
|---|---|
| `tests/decomposition/proposalStateMachine.test.ts` | The fold, silence-is-not-consent, spans surviving an edit, purity, entry validation |
| `tests/decomposition/proposalStore.test.ts` | Admission, scope, the port contract, idempotency, failure paths |
| `tests/decomposition/proposalBoundaries.test.ts` | The import closure, the scanner itself, the port being declaration-only |

Test wiring in `package.json` is owned centrally at merge time, so these run by
explicit path until then.
