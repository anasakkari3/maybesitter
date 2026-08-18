# Decomposition engine, validator and boundary

Sprint 06, issue #27. Owns `lib/decomposition/engine/**` and
`lib/decomposition/boundary/**`. Coordinates with #25 and #26 through
`src/contracts/v1/decompositionContracts.ts` only; it imports neither track,
which `tests/decomposition/boundaryImportClosure.test.ts` enforces over the
transitive import closure rather than over direct imports.

## Shape

```text
commitment text
→ rules detector (deterministic) or injected model provider
→ validator — the same check for both, always
→ proposal: decomposed | atomic (with a reason) | rejected (with violations)
→ explicit per-step confirmation
→ transactional persistence adapter
→ confirmed steps beside the commitment, which is never modified
```

Two invariants hold across every branch:

- **Nothing leaves the engine unvalidated.** Model output, rules output and
  model-output-replaced-by-rules all pass `validateDecomposition`, so a consumer
  never has to know which engine ran in order to know how much to trust a span.
- **A fallback always says why.** `DecompositionProvenance` makes
  `fallbackUsed: true` without a `fallbackReason` unrepresentable, and the
  reasons name the cause (`kill_switch_active`, `model_provider_failed`,
  `model_output_invalid`) rather than the effect. A week later, "used rules" and
  "was configured for rules" are the same sentence; the cause is not.

## Detector

Rules-first: given the same sentence it returns the same spans, and every
boundary traces to one named rule. The engine reads no clock and no random
source, which `boundaryImportClosure.test.ts` also checks by reading the source.

**Boundaries are character offsets, not word gaps.** In Arabic and Hebrew the
coordinating conjunction is a prefixed clitic — the "and" in `واطلب` and
`ותזמין` is character zero of the following word. A whitespace tokenizer cannot
express that boundary at all, so a clitic candidate is one code unit wide and
the next step begins mid-token.

**A candidate survives only when an action starts after it.** The same clitic
occurs inside fixed noun phrases (`والأحكام`, `וההגבלות`, `terms and
conditions`), where splitting invents a step. The discriminator is what follows
the conjunction:

| Script | Rule |
|---|---|
| Arabic | `ال` marks a definite noun and cannot open a step; `ا أ إ ت ي ن س` are imperative/imperfect prefixes and can. A short lexicon covers form II/III imperatives (`راجع`, `ذكّر`) that carry no visible prefix. |
| Hebrew | `ה` is the definite article and cannot open a step; `ת י א נ ל` are verbal prefixes and can. Particles (`את`, `של`, `אני`) are excluded first, because several begin with a letter that is also a prefix. |
| Latin | No morphology exists to use — `order` and `conditions` differ only in the word — so English uses a lexicon of common task verbs. |

**A step must be a phrase, not a word.** A one-token step is nearly always a
conjoined object the previous rule could not exclude. Hebrew is where this
bites: `ל` is both the infinitive prefix and the preposition "to", so `ולעומר`
("and to Omar") is morphologically identical to a conjoined infinitive. The
minimum-phrase rule costs the rare genuine one-word step and removes the whole
class of trailing-recipient over-splits.

**Timing travels verbatim.** A trailing time phrase (`by Friday`,
`يوم الاثنين`) is lifted out of the step's span into `statedTiming` unresolved.
Resolving it against a clock is Capture's job; computing a date here would be
`INVENTED_TIMING`.

**Owners are never populated.** No rule distinguishes the person who must act
from the person acted upon — "send a note to Sarah" names a recipient — so
`statedOwner` is always null rather than guessed.

**Dependencies come only from sequencing markers.** `then`, `ثم`, `وبعدها`,
`ואז` order the clauses they join, so the following step gets a `temporal` edge.
A plain conjunction or a comma joins without ordering; asserting an edge there
would invent a constraint the user never stated.

**Confidence** is the weakest boundary the split relied on: sequencing marker
0.9, standalone conjunction or comma 0.7, bare clitic 0.55. A caller raising
`minimumConfidence` loses clitic boundaries first, which is the correct order to
lose them in. Nothing split scores 0, so a refusal cannot be read as certainty.

### Measured behaviour, including the gaps

All 11 golden rows in `tests/fixtures/decompositionGolden.ts` reproduce exactly,
spans and dependency edges included. On held-out sentences of the same shapes,
two known gaps remain, both in the under-split direction:

1. **English recall equals lexicon coverage.** `Vacuum the car and polish the
   wheels.` does not split, because neither verb is listed. A verb missing from
   the lexicon produces a missed split, never a wrong one.
2. **Hebrew hif'il imperatives are read as nouns.** `והזמן` ("and order") starts
   with `ה`, which the article rule treats as nominal. Preferring the verb
   reading would split `וההגבלות`, which the golden set says is the worse error.

Both fail closed. That is the deliberate bias: an under-split loses a step the
user can still see in the original sentence, while an over-split invents one
that carries a span and therefore *looks* sourced.

## Validator

`validateDecomposition` emits `DecompositionViolation`s using only the shared
`DecompositionViolationCode` vocabulary, which #26's evaluator counts and #27
rejects on — one list, so a disagreement about what is wrong is a compile error
rather than a silent divergence.

| Code | Condition |
|---|---|
| `EMPTY_STEP` | Title blank or whitespace. |
| `CONJUNCTION_ONLY` | Title is only a connective — a split artefact, not a step. |
| `SPAN_MISMATCH` | `sourceText.slice(start, end) !== text`. |
| `SPAN_OUT_OF_RANGE` | Offsets are not a valid range in the source. |
| `SPAN_OVERLAP` | Two steps claim overlapping source text. |
| `INVENTED_TIMING` | `statedTiming` is not verbatim in the source. |
| `INVENTED_OWNER` | `statedOwner` is not verbatim in the source. |
| `INFERRED_WITH_SPAN` | Claims inference while citing source text. |
| `UNSOURCED_STEP` | No span and no admission of inference. |
| `DUPLICATE_STEP_ID` | Two steps share a `stepId`. |
| `UNKNOWN_DEPENDENCY` | An edge names no step in this proposal. |
| `CYCLIC_DEPENDENCY` | The dependency graph is not acyclic. |
| `SELF_DEPENDENCY` | A step depends on itself. |
| `SPLIT_ATOMIC` | A commitment declared do-not-split was split anyway. |

**Codes have precedence, and one defect reports one code.** Several conditions
imply each other: an out-of-range span also fails the round-trip and is excluded
from overlap comparison; a self-edge is also a cycle and is excluded from cycle
detection; a blank title is also "only a connective". Reporting every
technically-true code would give a reviewer four findings for one defect and no
signal about the cause. `validatorViolations.test.ts` asserts the *exact* code
set per case, so the precedence cannot drift.

**Violation details never quote the input.** Violations travel with proposals
and into audit records; a message echoing the offending text would put raw user
content everywhere a violation goes, defeating `rawInputInAudit: false` from a
direction nobody inspects.

## Giving up, explicitly

`AtomicProposal` has a required `reason` and **no `steps` field**, so a caller
cannot render a give-up as a decomposition of size one.

| Reason | Meaning |
|---|---|
| `not_decomposable` | This really is one task — the finding is about the commitment. |
| `below_confidence` | A split existed but scored under the caller's threshold. |
| `engine_unavailable` | We could not try: the model path failed and `allowRulesFallback` was false. |
| `validation_rejected` | Model output failed validation and no fallback was permitted. |

Where the model path is unavailable and no fallback is permitted,
`executedEngine` reports `'model'` because the contract offers no "neither"
value; the atomic reason carries the fact that nothing ran.

## Boundary

A sibling of `docs/architecture/capture-boundary.md`.

- Proposing never reaches the adapter, whatever the outcome.
- `RejectedProposal` and `AtomicProposal` are refused at confirmation
  (`proposal_not_decomposed`), not filtered at write time — so no code path
  makes the adapter's input depend on an outcome being read correctly.
- Every step needs its own verdict. A confirmation omitting a step is
  `incomplete_decisions`, never partially applied: the set the user did not
  accept must be stated, not inferred from what they left out.
- An edit keeps the step's spans. The user rewrote the wording, not the origin.
- A rejected step's incoming dependency edges are dropped rather than persisted
  as edges to something that does not exist.
- Confirmation is scoped and idempotent. A replay of the same `idempotencyKey`
  returns the stored result with `replayed: true`. A *different* decision set
  arriving after the write returns `proposal_not_found` — the proposal is spent,
  and treating it as a retry would report success for a ruling never applied.
- A failed adapter write leaves the proposal unspent, so the retry is a real
  write rather than a replay of a batch nobody applied.
- The adapter stages the whole batch against a private candidate state — id
  collisions and dangling edges included — and replaces canonical state only
  once every step validates. An empty batch is refused rather than reported as a
  successful no-op.
- Audit envelopes carry a SHA-256 hash and the length of the input, never the
  text. Asserted against every Arabic and Hebrew string in the golden set.

Confirmed steps live in their own store, not in `DomainState`. `Commitment` has
no notion of a step or a parent, Sprint 07's scheduler reads that type, and
pushing a schema change into a shared surface for an unrouted feature would be a
migration owed to nobody.

## Runtime controls

Decomposition runs under the **`planning`** runtime module. There is no
`decomposition` entry in `INTELLIGENCE_MODULES`, and adding one would edit a
contract three parallel tracks share mid-sprint; `planning` is the module the
roadmap files this capability under. `MAYBESITTER_FEATURE_PLANNING` and
`MAYBESITTER_KILL_SWITCH_PLANNING` therefore control it. A disabled or
kill-switched model path selects the rules detector and decomposition stays
available — the model changes the quality of a split, never whether one is
offered.

## Migration

None. `DomainState` is unchanged, proposals are not persisted as canonical
state, confirmed steps go to a new store with no existing rows, and there is no
production route or consumer. The work is additive and unrouted, exactly as
Sprint 01's capture boundary was.

`package.json` test wiring is owned centrally at merge time; run this track's
suite by path:

```bash
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/decomposition/*.test.ts
```

## Rollback

1. Set `MAYBESITTER_KILL_SWITCH_PLANNING=true` to force the deterministic
   detector while keeping decomposition available. This is the whole rollback
   for a model-provider problem.
2. For a detector or validator problem, stop callers from invoking
   `proposeDecompositionBoundary` and rule on already-issued proposals
   explicitly — a proposal is an offer and expires harmlessly if ignored.
3. Revert the #27 commit.

No canonical-state rollback is required at any step: proposing never writes, and
confirmation writes only to the decomposition step store, which has no consumer
outside this track. The original commitment is untouched by construction —
`DECOMPOSITION_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical` is true
and no proposal type carries a commitment mutation to apply. Verify a rollback
by running the suite above and comparing an adapter snapshot before and after an
unconfirmed proposal.
