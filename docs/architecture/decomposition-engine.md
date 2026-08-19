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

**Boundaries require positive lexical evidence, in every script.** The word
after the conjunction must be a known imperative; an unknown word yields no
boundary.

The first version of this detector did not work that way, and the reason it was
changed is worth keeping. It guessed "an action starts here" from the first
*letter* — Arabic `ا أ إ آ ت ي ن س`, Hebrew `ת י א נ ל` — with the definite
article as a veto. Those letters open a large share of ordinary indefinite
nouns, and Hebrew `ל` is the preposition "to" at least as often as an infinitive
prefix, so the rule fired on conjoined **objects**: `جهز العشاء وسلطة خضراء`
became two steps, and `תשלח מתנה לשרה ולדני כהן` invented an errand addressed to
half a name. Both survived the validator — the spans round-trip, the ids are
unique, the graph is acyclic — and were persisted. The golden `do_not_split`
rows had not caught it because each happens to place a definite article after
the clitic (`والأحكام`, `וההגבלות`) or leave a single-token recipient (`and
Omar`); adding a surname dissolves both mitigations.

A guess dressed as morphology is still a guess, and this one failed in the
inventing direction, in the two languages that are the issue's named acceptance
criterion. The lexicons are:

| Script | Evidence |
|---|---|
| Arabic | Imperatives, normalized: diacritics stripped, hamza-carrying alef folded to bare alef, final ya folded — `أرسل` and `ارسل` are the same instruction from different keyboards. Attached object pronouns are stripped before lookup, because Arabic suffixes the object onto the verb (`ارسله` = `ارسل` + `ه`) and most transitive instructions are phrased that way. |
| Hebrew | Imperatives in all three ordinary task forms: 2nd-person future used as imperative (`תשלח`), infinitive (`לשלוח`), and bare imperative (`שלח`). |
| English | Common task verbs, unchanged — English never had morphology to lean on, so it always worked this way. |

Dropping the prefix rule also **closed** the hif'il gap the previous version
documented: `ה`-initial imperatives (`הזמן`, `הכן`) can now be listed, because
protecting `וההגבלות` no longer requires treating every `ה` as an article.

**Both clauses must be phrases.** A one-token clause beside a mere conjunction
is a conjoined object that slipped the lexicon. This rejects *that boundary
only* — never the whole split — and never applies to an explicit sequencing
marker. Discarding the whole split had a worse failure than the one it
prevented: `Email the client, then call.` returned `atomic: not_decomposable`,
telling the caller the commitment was one action because a token count
overruled the strongest evidence the detector has.

**A sentence-final `.` is not a boundary**, so `Call the dentist. Buy the milk.`
yields no split. Sentence segmentation is a separate problem with its own
abbreviation traps (`Dr.` is in the golden set) and getting it wrong splits
inside a name. Under-split, and stated.

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

**Confidence ranks kinds of evidence, not the quality of a split.** Sequencing
marker 0.9, standalone conjunction or comma 0.7, bare clitic 0.55; the result is
the weakest boundary used, and 0 when nothing split. Read the number for what it
is: every clitic boundary scores 0.55 whether it is right or wrong, so
`minimumConfidence` cannot separate a good clitic split from a bad one. What it
can do is switch off a whole class of evidence — a threshold above 0.55 disables
clitic-based decomposition, which is most of Arabic and Hebrew. That is a blunt
but legitimate conservative posture, and it is the only thing the knob does.
Correctness of individual boundaries is the lexicons' job, not the threshold's.

### Measured behaviour, including the gaps

All 11 golden rows reproduce exactly — spans, timings and dependency edges —
before and after the rewrite. The rewrite was measured on two held-out classes,
neither drawn from the fixtures:

| Class | Before | After |
|---|---|---|
| Conjoined object or recipient, must **not** split (n=20) | 7 over-split | **0 over-split** |
| Genuinely two actions, **should** split (n=20) | 15 recalled | 15 recalled |
| Golden set, exact match (n=11) | 11 | 11 |

Recall was expected to fall and was budgeted for; it did not, because the
object-pronoun stripping recovered what the lexicon lost. Had the two traded
against each other the trade would still have been taken: under-splitting loses
a step the user can still read in their own sentence, while over-splitting
invents one that carries a span and therefore *looks* sourced.

The five remaining recall misses, all fail-closed:

1. **Lexicon coverage bounds recall in every script.** `Wash the car and vacuum
   the seats.`, `Polish the shoes and iron the shirt.`,
   `תסגור את החלון ותכבה את האור.` — the second verb is not listed.
2. **A one-word clause after a mere conjunction is folded back**, by design.
   `جهز العرض واطبعه.` stays one step even though `اطبعه` is recognised. The
   same rule is what keeps `وعمر` and `ולעומר` from becoming errands.
3. **Object-pronoun stripping only helps when the stem is listed.**
   `اشتر الهدية وغلفها.` misses because `غلف` is not a listed imperative.

One known over-split risk remains, recorded rather than papered over: Hebrew
`תקנה` is both "you will buy" and "regulation", and Hebrew is written without
vowels, so `ותקנה` after a noun can still split wrongly. It stays in the lexicon
because it is a common task verb and removing it loses a frequent correct split.

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
| `SPAN_OUT_OF_RANGE` | Offsets are not a valid non-empty range in the source. A degenerate `[n, n)` is in bounds and claims nothing, and `slice(n, n) === ''` matches a `text` of `''`, so the round-trip check would pass it silently. |
| `SPAN_OVERLAP` | Any two spans in the proposal overlap, **including two spans of the same step** — a step double-claiming its own words is exactly as wrong as two steps colliding. |
| `INVENTED_TIMING` | `statedTiming` is blank or not verbatim in the source. Absence is spelled `null`; `''` is a claim about nothing, and `includes('')` is always true. |
| `INVENTED_OWNER` | `statedOwner` is blank or not verbatim in the source. |
| `INFERRED_WITH_SPAN` | Claims inference while citing source text. |
| `UNSOURCED_STEP` | Two shapes under one code: no span and no admission of inference, **or** a title its own spans do not select. Both say the same thing — this step's content is not traceable to what the user wrote — and #26's evaluator counts them together. |
| `DUPLICATE_STEP_ID` | Two steps share a `stepId`. |
| `UNKNOWN_DEPENDENCY` | An edge names no step in this proposal. |
| `CYCLIC_DEPENDENCY` | The dependency graph is not acyclic. Emitted **once per proposal** with `stepId: null`, naming the participating ids in `detail`. |
| `SELF_DEPENDENCY` | A step depends on itself. |
| `SPLIT_ATOMIC` | A commitment declared do-not-split was split anyway. Over-split direction only; a `multi_step` row with too few steps is #26's corpus concern and is unreachable here, since `DecomposedProposal.steps` is a two-or-more tuple. |

**Titles carry provenance too.** A non-inferred step's title must be exactly
what its spans select, modulo whitespace. Checking the spans alone left the
invention channel that matters wide open: a provider could cite real offsets and
put anything at all in the title, and the title is the field the user reads and
the adapter persists. A provider returning valid spans with the titles
`Wire $9,000 to account 12345` and `Delete all backups` validated, confirmed and
persisted. The contract's premise is that provenance is a *round-trippable
assertion*; a title nothing sources is not one. An edited title is exempt — it
is confirmed at the boundary and never re-validated, because the user is allowed
to say something the engine did not read.

This reports as `UNSOURCED_STEP` rather than a private code. The merge-time
cross-track run compares this validator against #26's evaluator code-for-code,
and a finding only one side can name is a divergence by construction; both sides
now implement the check under the shared name.

**One defect reports one code, once.** Precedence decides *which* code; cardinality
decides how many. A dependency cycle is one violation attributed to the proposal
rather than one per step caught in it — a caller handed N rejections for one
cycle cannot tell N problems from one, and no step in a cycle is more at fault
than the others. `stepId: null` is what the contract reserves for proposal-level
findings.

**Codes have precedence, and one defect reports one code.** Several conditions
imply each other: an out-of-range span also fails the round-trip and is excluded
from overlap comparison; a self-edge is also a cycle and is excluded from cycle
detection (`SELF_DEPENDENCY` wins, never both); a blank title is also "only a
connective"; a broken span suppresses the title-provenance check, because a
title cannot be compared against a span that is unusable. Reporting every
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
- Confirmation is scoped, idempotent, and **claimed before it writes**. The
  claim (the idempotency key, plus the in-flight attempt) is recorded before the
  adapter is awaited. Recording it afterwards left a window between reading the
  proposal and storing the result that a second confirmation walked straight
  through: two rulings with disjoint accept sets both returned `success: true`,
  both wrote, and every step rejected in the first ruling became canonical —
  defeating `everyStepNeedsExplicitDecision` on a UI double-submit. A concurrent
  replay of the *same* key now awaits the one real attempt rather than starting
  a second write. A replay returns the stored result with `replayed: true`. A *different* decision set
  arriving after the write returns `proposal_not_found` — the proposal is spent,
  and treating it as a retry would report success for a ruling never applied.
- A failed adapter write leaves the proposal unspent, so the retry is a real
  write rather than a replay of a batch nobody applied.
- The adapter stages the whole batch against a private candidate state — id
  collisions and dangling edges included — and replaces canonical state only
  once every step validates. An empty batch is refused rather than reported as a
  successful no-op.
- Input that is not a string never reaches the engine. It returns
  `atomic: engine_unavailable` and audits as `failed`. Coercing it to `''` and
  letting the engine answer `not_decomposable` recorded "we read this and it is
  one action" about input nobody read — a caller bug filed as a determination
  about a commitment.
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

**The kill switch does not stop confirmations.** `proposeDecompositionBoundary`
consults `resolveModuleRuntime`; `confirmDecomposition` does not, so setting
`MAYBESITTER_KILL_SWITCH_PLANNING` stops new proposals from using the model but
does **not** block an already-issued proposal from being confirmed and written.
This mirrors Sprint 01, where `confirmCapture` likewise does not consult runtime
controls, and it is deliberate rather than overlooked: the rules-only contract's
`allowsDirectStateWrites: false` governs writes the *module* makes on its own,
not writes a user explicitly confirmed, and `planning` defaults to flag-off — so
gating confirmation on it would block every confirmation by default and strand
proposals a user had already ruled on. Step 2 below is therefore load-bearing
and not optional: stopping callers is what stops writes.

No canonical-state rollback is required at any step: proposing never writes, and
confirmation writes only to the decomposition step store, which has no consumer
outside this track. The original commitment is untouched by construction —
`DECOMPOSITION_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical` is true
and no proposal type carries a commitment mutation to apply. Verify a rollback
by running the suite above and comparing an adapter snapshot before and after an
unconfirmed proposal.
