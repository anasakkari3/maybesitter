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
- An `edit` fails with `invalid_edit` when its title would not have been
  admissible as a proposed one — blank, punctuation-only, or a bare connective.
  One standard on both paths: the edit path once used a plain `trim()`, so a
  user could edit a step into `"and"` or `"."` and the port received a title
  admission would have rejected outright.
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
| `EMPTY_STEP` | Title has no words once invisible marks and punctuation are removed |
| `CONJUNCTION_ONLY` | Title is only a connective — `and`, `then`, `و`, `ثم`, `ו`, `ואז` |
| `DUPLICATE_STEP_ID` | Two steps share a `stepId` |
| `SELF_DEPENDENCY` | A step depends on itself |
| `UNKNOWN_DEPENDENCY` | An edge points at no step in the proposal |
| `CYCLIC_DEPENDENCY` | The dependency graph is not acyclic (proposal-level, `stepId: null`) |
| `INFERRED_WITH_SPAN` | `inferred` is true while the step cites source spans |
| `UNSOURCED_STEP` | The step cites no span and does not admit to being inferred |

Titles are normalised before either check: combining marks and invisible format
characters are removed first, then punctuation and symbols. Both mattered in
practice — vocalized Arabic (`وَ` is waw + fatha) and a pasted right-to-left mark
(`‏و`) are different strings from the bare conjunction while looking identical on
screen, so the artefact walked straight through. The punctuation class also had
a latent bug: the ASCII hyphen sat inside `‐-―`, which a regex reads as the
*range* U+2010–U+2015, so `-` was a range delimiter and never a member and a
title of `"-"` was not empty.

`CONJUNCTION_ONLY` matches the whole title only. Arabic and Hebrew write the
conjunction as a clitic prefixed onto the next word with no whitespace
(`واطلب`, `ותזמין`), so a splitter that strips the prefix emits the bare letter
as if it were a step — a one-character artefact that passes any "non-empty
title" check, which is why it is a separate code. A title that merely *starts*
with a connective is a real step and is admissible; rejecting those would break
exactly the golden rows the clitic handling exists to support.

`INFERRED_WITH_SPAN` and `UNSOURCED_STEP` *are* checked here. Both are a
consistency check between a step's own `inferred` flag and its own
`sourceSpans`, decidable from the step alone, and `UNSOURCED_STEP` is the
provenance deliverable itself — a step with no span and no admission is
indistinguishable from an invented one, and admitting it would put an unsourced
step in front of a user.

`SPAN_MISMATCH`, `SPAN_OUT_OF_RANGE`, `SPAN_OVERLAP`, `INVENTED_TIMING`,
`INVENTED_OWNER` and `SPLIT_ATOMIC` are **not** checked here. Not for want of the
source text — `proposal.sourceText` is on the proposal this module already
receives — but because each is a judgement about the *engine's reading* of that
text, which belongs to #27's validator and #26's evaluator. Two independent
implementations of the same judgement is the second opinion the shared
vocabulary exists to prevent; a consistency check on one step's own fields is
not.

An inadmissible proposal is not stored, so it is not merely unconfirmable — it is
not offerable. A `rejected` proposal is refused admission carrying its own
violations rather than re-derived ones.

A proposal id is admitted **once**. Re-admitting a held id is refused
(`reason: 'already_admitted'`) rather than overwriting the entry. The overwrite
was a real hole: it reset the stored confirmation, so re-admitting an applied
proposal made it applicable a second time, and re-admitting it under a different
`scopeId` moved a live proposal into a scope that never owned it. A guard any
caller can clear by calling `admit` again is not a guard.

### Confirmation, scope and idempotency

- Confirmation is scope-checked. A mismatch reports `proposal_not_found` rather
  than "not yours", so a caller outside the scope does not learn the id exists.
- A replayed identical confirmation (same `idempotencyKey` **and** same
  decisions) returns `replayed: true` and does not call the port again.
- Anything else against an already-confirmed proposal reports
  `already_confirmed`: a reused key carrying different decisions, or a fresh key
  against a proposal that has already been applied. Not `proposal_not_found` — a
  caller told its proposal does not exist will retry, and this is the one case
  where retrying is exactly wrong.
- Confirmations for one proposal are **serialized**. Recording after the port
  returns leaves a window, and two concurrent callers both read an unconfirmed
  proposal and both reached the port. `confirm` now chains onto any call already
  in flight for the same id before it yields; the chaining is synchronous up to
  the first await, which is what makes the reservation atomic on a
  single-threaded loop.
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

### Nothing mutable leaves the store

An admitted proposal is cloned and deep-frozen, and the batch handed to the port
is frozen too. The store used to return the caller's own object, and a confirmed
step shared its `sourceSpans` array with the stored proposal — so an adapter
normalizing spans in place would rewrite the provenance of the stored proposal.
That is exactly the corruption the reducer's "spans are never touched" rule
exists to prevent, reached by a route that rule did not cover. Cloning also means
a caller mutating its own object after admission cannot change what was admitted.

## Failure and compatibility behaviour

- The reducer reads no clock and no random source, imports no I/O primitive, and
  has no writer on any **runtime** path in its transitive import closure. All
  four are checked by source scan in
  `tests/decomposition/proposalBoundaries.test.ts`, not asserted in a comment.
  Three properties of that scan are worth stating precisely, because each was
  wrong at first and a boundary test that is wrong is worse than none:
  - It resolves the `@/*` alias to `src/`. It previously followed only
    `./`-relative specifiers, while `@/` is the repo's dominant spelling (76
    imports across `lib/` and `src/`), so anything reached through one was
    invisible.
  - It reads comment-stripped source. Reading raw source let prose in a doc
    comment match the import pattern and consume past a real `import` statement
    — a false negative that hid the contract chain's edge to
    `src/domain/stateMachine` entirely.
  - It distinguishes erased `import type` edges from value edges. The frozen
    contract chain reaches `src/domain/stateMachine` through exactly one
    `import type` (`lifeStateContracts.ts` naming `DomainState`) and no other
    edge. A type import executes nothing and can write nothing; a test asserts
    that this edge stays type-only and that no runtime path reaches that module.
  - An unresolvable non-bare specifier throws rather than returning null, so an
    edge the scanner cannot follow is a failure instead of a silent gap.
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
3. Revert the focused #25 commits. `lib/decomposition/proposal/**`,
   `tests/decomposition/proposal*.test.ts` and this document are the whole
   surface, plus one additive member (`already_confirmed`) on
   `ConfirmationFailureCode` in `src/contracts/v1/decompositionContracts.ts`.
   That member may be left in place on a rollback: it is additive, no existing
   member changed, and nothing outside this module reads the code yet.

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
