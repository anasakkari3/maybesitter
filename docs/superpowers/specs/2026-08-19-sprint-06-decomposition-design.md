# Sprint 06 — Decomposition: Design

Date: 2026-08-19
Issues: [#25](https://github.com/anasakkari3/maybesitter/issues/25), [#26](https://github.com/anasakkari3/maybesitter/issues/26), [#27](https://github.com/anasakkari3/maybesitter/issues/27)
Base: `fae9afa` (`origin/main`, Sprint 05 merged)

## Context

Sprint 06 turns one commitment into a proposal of several steps. "Plan my sister's wedding"
becomes book the venue, send the invitations, order the cake — offered, not applied.

Sprint 01 established the shape this has to take: model output is untrusted, so it can only
produce a proposal, and canonical writes belong to an adapter reachable only after explicit
confirmation. Decomposition is that boundary applied to a harder object. A capture proposal was a
list of independent items; a decomposition is a graph over spans of one sentence, and every step
in it claims to have come from words the user actually said.

## Corrected premises

Three things the issues assume are no longer, or were never, true. Each is corrected here rather
than implemented as written.

1. **The issues say to "coordinate only through the contracts named in this issue", and then name
   no contracts.** They were written before any existed. `src/contracts/v1/decompositionContracts.ts`
   is written first, before the parallel tracks start, and is the surface they coordinate through.

2. **#25 asks for an "accept/edit/reject state machine", which reads as an extension of the domain
   state machine.** `Commitment` in `src/domain/stateMachine.ts` has no notion of a step or a
   parent, and Sprint 07's scheduler reads that type. Extending `DomainState` for a feature that is
   not production-routed would push a schema change into a shared surface for no live consumer.
   **Corrected: the state machine is a pure reducer over proposal state**, and confirmed steps
   leave through an injected persistence port. `DomainState` does not change this sprint. This
   matches the roadmap's own note that Sprint 06 "operates on commitments from Life-State
   (Sprint 02); stub/mock otherwise".

3. **#26 asks for a *reviewed* dataset, and no reviewer exists.** The issue already applies the
   scope split; this design states what the split means in the data. The pipeline is real and
   exercised; every row it ships is `provenance: 'synthetic'`; the human-reviewed corpus ships
   empty. This is the rule Sprint 04 set with its empty judgment corpus and Sprint 05 kept: a
   dataset that claims review it never had corrupts every number computed from it afterwards, and
   does so invisibly, because fitted numbers look the same either way.

## Architecture

| Component | Path | Owner |
|---|---|---|
| Shared contract | `src/contracts/v1/decompositionContracts.ts` | written first (Step 0) |
| Golden set | `tests/fixtures/decompositionGolden.ts` | written first (Step 0) |
| Proposal state machine + store | `lib/decomposition/proposal/**` | #25 |
| Architecture / migration / rollback doc | `docs/architecture/decomposition-boundary.md` | #25 |
| Dataset, splits, evaluator | `lib/decomposition/evaluation/**`, `data/quality/**` | #26 |
| Annotation guide | `docs/data/decomposition-annotation-guide.md` | #26 |
| Detector, validator, boundary service, adapter | `lib/decomposition/engine/**`, `lib/decomposition/boundary/**` | #27 |
| **Cross-track test** | `tests/decomposition/decompositionCrossTrack.test.ts` | **merge-time, centrally** |
| **`package.json` test wiring** | `package.json` | **merge-time, centrally** |

The last two rows are the point of the table. Sprint 05 gave `policyFreeze` to the merge rather
than to the track it constrained, for the reason that a check owned by the thing it checks is not a
check. The same applies here twice over: the cross-track test exists to catch disagreement between
#26 and #27, so neither may own it, and `package.json` is the one file all three tracks would
otherwise edit — a three-way conflict in a space-separated string, whose careless resolution drops
test coverage silently. No track touches it; workers run their suites by explicit path.

### The shared vocabulary

`DecompositionViolationCode` is the load-bearing part of the contract. #27 rejects proposals
carrying these codes; #26 counts them to score a dataset. Built separately, each track would have
named violations for itself, both suites would pass, and the two would disagree about what a
correct decomposition is with nothing to notice. Sprints 02, 03, 04 and 05 each needed a cross-track
run to catch that class of drift; this sprint pins the vocabulary in the contract *and* keeps the
cross-track run.

### Spans

A `SourceSpan` is a half-open `[start, end)` range in UTF-16 code units over the original text,
carrying the text it selects. Three consequences worth stating because each is a place this could
have gone wrong:

- **Code units, not code points or tokens**, because that is what `String.prototype.slice` indexes.
  A definition that disagreed with the language's own indexing would be wrong for every string
  containing an emoji or an astral character.
- **Right-to-left needs no special handling.** Arabic and Hebrew render RTL, but storage order is
  logical, so a span over an RTL clause is an ordinary increasing range. The bidi problem is a
  rendering problem, and spans are not rendering.
- **The text travels with the offsets**, so `raw.slice(start, end) === text` is checkable.
  Provenance that cannot be checked drifts; this is the assertion the golden set and the validator
  both run.

## Dependency matrix

| | #25 | #26 | #27 |
|---|---|---|---|
| **File overlap** | none after Step 0 | none | none |
| **Contract overlap** | consumes Step 0 | consumes Step 0 | consumes Step 0 |
| **Schema/data overlap** | none | owns `data/quality/decomposition-*` | none |
| **Runtime dependency** | none | none | none — imports contracts, not #25/#26 |
| **Test overlap** | `tests/decomposition/proposal*` | `tests/decomposition/dataset*`, `evaluator*` | `tests/decomposition/engine*`, `validator*`, `boundary*` |
| **Ordering dependency** | Step 0 | Step 0 | Step 0 |

After Step 0 the three are genuinely independent: no track imports another, and the shared files
they would all have edited (`src/contracts/v1/index.ts`, `package.json`, the golden set) are
already written or reserved for merge-time. The residual risk is semantic, not mechanical, and the
cross-track test is what addresses it.

**Execution order:** Step 0 serial → #25 ∥ #26 ∥ #27 → merge-time wiring + cross-track → integration.

## Component 1 — Proposal contracts and state machine (#25)

| Criterion | Mechanism |
|---|---|
| Original commitment remains canonical until confirmation | `DECOMPOSITION_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical`, and structurally: no proposal type carries a commitment mutation, and the reducer has no writer dependency to reach one through. A boundary test walks the transitive import closure — the technique that caught a real side-effect-import gap in Sprint 03. |
| Empty or conjunction-only steps are invalid | `EMPTY_STEP` and `CONJUNCTION_ONLY` in the shared violation vocabulary, applied by the reducer on entry, not only at the engine. |
| Partial acceptance is explicit | `decisions` must cover every step exactly once. A missing step invalidates the request (`incomplete_decisions`) rather than defaulting: the set the user did not accept must be stated, never inferred from what they left out. |
| Stable source-span/provenance links | Spans survive accept, edit and reject unchanged. An edited step keeps the span it came from — the user rewrote the title, not the origin. |

## Component 2 — Dataset and evaluator (#26)

**Buildable now:** annotation guidance, queue and ingest, deterministic checksum-protected
train/valid/locked-test splits, and the three metrics.

**Stub:** the human-reviewed rows. The corpus ships empty; seed rows are `provenance: 'synthetic'`.

| Criterion | Mechanism |
|---|---|
| Source segments are exact and non-overlapping | Exactness is `raw.slice(start, end) === text`, checked, not asserted. Non-overlap is checked pairwise per example. Both are `SPAN_MISMATCH` / `SPAN_OVERLAP` from the shared vocabulary, so the evaluator's finding and the validator's rejection are the same finding. |
| No invented dates or owners | `statedTiming` and `statedOwner` must occur verbatim in the source text (`INVENTED_TIMING`, `INVENTED_OWNER`). Resolving "next week" to a date is Capture's job; a decomposer computing one has invented a fact. |
| Do-not-split cases are represented | Four of eleven golden rows are `do_not_split`, across English, Arabic and Hebrew. Deliberately over-weighted: over-splitting is the failure that survives a green suite, because a splitter firing on every conjunction scores well on the multi-step rows and only shows its damage where firing is wrong. |
| Splits are deterministic and leak-free | Assignment by digest of `exampleId`, not by iteration order or wall clock; a locked-test row may not also appear in train or valid. |

**Non-goal, stated plainly:** reporting a score from the synthetic corpus as evidence about model
quality. The corpus exists to prove the pipeline runs.

## Component 3 — Engine and validator (#27)

| Criterion | Mechanism |
|---|---|
| Single-item fallback is explicit, never heuristic masquerading as reviewed | `AtomicProposal` is a separate variant with a required `reason`, and has no `steps` field. A caller cannot read a give-up as a decomposition because there is nothing to read — and `not_decomposable` ("this is one task") is a different reason from `engine_unavailable` ("we could not try"). |
| Invalid proposals do not persist | A `RejectedProposal` carries violations and no steps; confirmation refuses any outcome other than `decomposed`. The adapter evaluates the whole batch against a private candidate state before committing, as Capture's does, so a partial apply is not reachable. |
| Arabic/Hebrew ordering tests pass | The golden set carries the two cases that break naive splitters: the conjunction as a prefixed clitic with no whitespace to split on (`واطلب`, `ותזמין`), and the same clitic inside a fixed noun phrase where splitting is wrong (`والأحكام`, `וההגבלות`). Rules-first, so the behaviour on these is deterministic and inspectable rather than a model's mood. |
| Rules-first with optional model provider | The model provider is injected and optional; absent or failing, the rules detector runs and `provenance.fallbackUsed` is `true` with a `fallbackReason`. The type makes a reasonless fallback unrepresentable — a fallback whose cause is unrecorded reads, a week later, exactly like a deliberate rules-only run. |

## Not in scope

Re-decomposition of a step, Sprint 07 scheduling semantics, any UI surface, and any production
route. Sprint 06 is additive and unrouted, exactly as Sprint 01's capture boundary was. The one
forward-looking concession is `DependencyKind`, typed now because Sprint 07's scheduler reads these
edges and an untyped edge cannot tell it whether two steps are sequential or merely share a
resource — one field now against a breaking change to a contract later.

## Migration and rollback

No stored-state migration: `DomainState` is unchanged, proposals are not persisted as canonical
state, and there is no production consumer. Rollback is reverting the sprint commits; nothing to
undo in user data because nothing was written to it. Kill-switch behaviour follows Sprint 00
runtime controls — a disabled model path selects the rules detector, and decomposition stays
available.
