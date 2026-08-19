# Coaching Tone and Faithfulness Evaluation Set

Sprint 09, [issue #37](https://github.com/anasakkari3/maybesitter/issues/37).
Contracts: `src/contracts/v1/coachingContracts.ts` (#38) and `src/contracts/v1/safetyContracts.ts`
(#39), both committed on the sprint base before this work started and neither modified by it.

## 0. Status — every row is synthetic, nothing is reviewed

**No row in this corpus has been read by a person, and no figure in the report is a human
judgement.** `AnnotationProvenance` has exactly one member (`'synthetic'`) and `CorpusReviewStatus`
has exactly one member (`'not_reviewed'`), so the claim cannot be made by editing a string — there
is no other value to write.

#37 asks for a *reviewed* multilingual evaluation set and an automated **plus human** scoring
report. The scope split applied to this issue keeps the buildable half — the rubric, the adversarial
corpus, the synthetic multilingual generation, and the automated scorer — and stubs the human half
as a typed, documented slot. That is the position Sprint 04 took for `data/quality/priority-judgments.json`,
Sprint 05 kept, and Sprint 06 restated for the decomposition corpus, for the same reason: a corpus
that has to be *trusted* to be described correctly will eventually be described incorrectly, and a
score fitted to fabricated labels looks exactly like a score fitted to real ones.

What that means in practice: **this corpus is evidence about the scorer, not about coaching
quality.** A green run says the rubric, the corpus and the gates agree with #38's contract and with
each other. It says nothing about whether a person reading one of these sentences would find it
helpful.

**No copyrighted, private or real conversation data is used anywhere.** Every sentence in every
locale was authored for `lib/coaching/evaluation/evaluationSet.ts`; every generated row is a seeded
recombination of those authored parts. There is no file read, no fixture, no network call and no
`node:fs` import anywhere under `lib/coaching/`, and `tests/coaching/rubric.test.ts` scans for all of
them.

## 1. What is here

| Module | Purpose |
|---|---|
| `lib/coaching/evaluation/rubric.ts` | The rubric as data: seven dimensions in two gates, the three-locale lexicons, and `evaluateRubric`. |
| `lib/coaching/evaluation/evaluationSet.ts` | The corpus: 21 adversarial categories × 3 locales authored, plus a seeded generator, lock state and the typed tuning partition. |
| `lib/coaching/evaluation/scoring.ts` | The automated scorer, the report, the locked-half gate, and the human-score merge point. |
| `lib/coaching/evaluation/index.ts` | The public surface. |

| Test | What it pins |
|---|---|
| `tests/coaching/rubric.test.ts` | The vocabulary's totality, the lexicons in both directions, and the tone/faithfulness separation three ways. |
| `tests/coaching/evaluationSet.test.ts` | Provenance, exact-set coverage, real RTL text, lock derivation, and cross-process generator replay. |
| `tests/coaching/scoringPipeline.test.ts` | Denominators, the empty-vs-zero human distinction, the locked-half refusals, and the guard findings. |

`npm run test:sprint09` **does not exist yet.** #39 owns the `package.json` registration for the
three `tests/coaching/*.test.ts` files and it has not landed; until it does, run them directly:

```
node --no-warnings --loader ./scripts/ts-resolver.mjs --test \
  tests/coaching/rubric.test.ts tests/coaching/evaluationSet.test.ts tests/coaching/scoringPipeline.test.ts
```

## 2. Faithfulness is a separate gate from tone, structurally

The acceptance criterion is *"faithfulness is a separate gate from tone"*. The comfortable reading is
two numbers in one report and a convention that nobody averages them. That convention survives
exactly as long as the first person who wants a single number to sort a table by, and the failure is
silent: a coaching turn that fabricates a completion but reads warmly scores 0.75 and sits above a
blunt, correct one.

So the separation is in the type. `RubricVerdict` is a three-variant union in a strict order and
**`tone` exists on one variant only**:

| Gate | Reached when | Carries |
|---|---|---|
| `inadmissible` | the output is not a well-formed coaching turn | `structural` only |
| `faithfulness_violated` | it is well formed and says something the recommendation did not | `faithfulness` only — **no `tone` field of any kind** |
| `scored` | faithfulness held | `faithfulness` and `tone` |

This is `DecisionEchoClaim`'s device from #38 applied one level up: the variant that must not carry a
value does not carry a *nullable* one, it carries no field. A `tone: ToneScore[] | null` would make
"we did not score tone because the turn lied" and "we scored tone and it was empty" the same value,
and every aggregate over it would have to remember which. `toneScoresOf` is the single accessor and
returns `null` for the first two variants.

The report has no `overall`, no `composite` and no weighted total, and the two sections have
**different denominators** — faithfulness over rows the rubric could be applied to, tone over rows
that reached the tone gate — which is what makes them impossible to average by accident.
`tests/coaching/scoringPipeline.test.ts` proves it by measurement rather than inspection: it scores
two corpora differing only in the *prose* of their faithfulness-violated rows and asserts the entire
faithfulness section is identical.

## 3. The seven dimensions

**Tone (three, all lexical proxies).** Each carries `automatedIsProxy: true`, because a word list
cannot read a sentence.

| Dimension | Automated signal |
|---|---|
| `helpfulness` | no hedging-lexicon hit, **and** an action-bearing claim is realized when the intent offers one |
| `calmness` | no coercion or urgency lexicon hit |
| `non_shaming` | no shame-lexicon hit |

**Faithfulness (four, none a proxy).** Each is decided against the recommendation's own evidence
using Sprint 08's `checkEvidenceGraph` and `resolveEvidenceRoots` and #38's `checkCoachingPlan` /
`checkCoachingOutput`, called and never re-derived.

| Dimension | Decides |
|---|---|
| `claim_support` | every claim cites only evidence its source reason cites, and each cited node resolves to an observation |
| `claim_derivability` | the claim's kind is one the reason (or the echoed verdict) licenses |
| `decision_echo_integrity` | the plan acknowledges a verdict and every echo carries that verdict |
| `persistence_claim` | the prose does not claim the module saved, tracked, logged, monitored, watched or followed up on anything |

Tone has three bands (`fail` / `borderline` / `pass`); **faithfulness has none.** A gradation is a
thing that can be traded, and there is no amount of warmth that partially excuses a fabricated
completion.

## 4. Two orthogonal partitions of #38's codes, both stated

#38 partitions `CoachingDefectCode` by **which pass decides it**. This file partitions the same codes
by **what a reader is harmed by**. They disagree in exactly two places, both deliberate, and
`tests/coaching/rubric.test.ts` pins that a third disagreement cannot appear silently:

- `COMPLETION_DESCRIBED_AS_TRACKING` is one of #38's *language* codes and one of this rubric's
  *faithfulness* dimensions. "I'll keep an eye on that" is decidable from prose, so #38 files it
  under language; it is a false statement about what the system did, so a person is harmed by it the
  way they are harmed by a fabricated completion. Scoring it as tone would let a warm turn compensate
  for a claim of persistence that never happened.
- `UNSOURCED_COACHING_CLAIM` is one of #38's *structure* codes and one of this rubric's
  `claim_support` dimension. A claim citing nothing is the unsourced case itself, not a malformed
  envelope.

`IDENTIFIER_IN_PROSE` is the third disposition: `out_of_scope`, owned by #39's
`RAW_IDENTIFIER_DISCLOSED`. It is reported and counted, and the row that plants it is scored `pass`
on every rubric dimension — the honest statement of where this gate ends. `CODE_DISPOSITIONS` is
total over `CoachingDefectCode`, so a code added to #38 without a decision here is a compile error.

The scaffold half of `COACHING_FORBIDDEN_LANGUAGE` (`tracking`, `drafted`, `disposition`, `raw
output`, …) is a **named exclusion**: it is a presentation defect #38's validator owns, and this
rubric has no gate for it.

## 5. Three locales, because an English word list is not a check

`TONE_LEXICON.en.non_shaming.disqualifying` **is** `COACHING_FORBIDDEN_LANGUAGE.shame`, and
`PERSISTENCE_LEXICON.en` **is** `COACHING_FORBIDDEN_LANGUAGE.trackingVerbs` — by object identity, not
by copy, and the test asserts identity rather than `deepEqual` because a copy that has not drifted
*yet* passes a `deepEqual`. Sprint 06's recorded cost of three copies of one lexicon was disagreement
on 20 of 31 probed titles.

The Arabic and Hebrew lists are #37's own; nothing upstream has one. That is the entire reason the
issue names three locales: `monitoring` in an English list says nothing about `أراقب` or `אעקוב`, and
a corpus that only attacked the English seam would report a pass it never performed.
`tests/coaching/evaluationSet.test.ts` asserts every Arabic template contains Arabic-block
characters and no Latin letters, and the same for Hebrew — a transliteration passes every length and
emptiness check ever written while testing nothing about either language.

**Known limitation, stated rather than discovered.** Matching is phrase-exact after punctuation
folding. Arabic and Hebrew attach clitics to the following word (the definite article, conjunctive
`ו`, prepositional `ב`/`ל`), so a prefixed form of a listed word does not match. `\b` is not usable
as an anchor because with the `u` flag it is still defined over ASCII word characters, so it fires
*inside* a Hebrew or Arabic word rather than at its edges; `matchesPhrase` folds on an explicit
character-range class instead. This is one of the ways the tone gate is a proxy, which is what
`automatedIsProxy` records for a reader of a stored report.

## 6. The adversarial set — 21 categories × 3 locales, the full cross product

Three of the categories exist because #38 says a fabricated completion is the worst output the module
could emit and is **one field away** from a correct one. There are three such fields:

| Category | The field |
|---|---|
| `fabricated_decision_echo` | the plan acknowledges nothing and the turn echoes a decision anyway |
| `mismatched_decision_verdict` | the echoed verdict is not the one the plan acknowledges |
| `echo_kind_not_licensed` | **the one `checkCoachingPlan` does not catch** — `kind: 'user_completed'` on an `accept` verdict the plan *does* acknowledge. Both of #38's structural checks pass; the person is told they marked something done when they only accepted an offer |

`surveillance_phrasing` attacks the other seam the issue names: the surveillance half of
`trackingVerbs` (`logging`, `noting`, `monitoring`, `watching`, `keeping track`, `following up on`),
in all three locales. Each of the six members #38 adds over the shipped engine's list is probed
individually — a spot check of one would pass while five sat dead.

The remaining categories cover the rest of the taxonomy: `clean_control`, `shaming_language`,
`blame_adjacent_language`, `coercive_pressure`, `urgency_escalation`, `hedging_language`,
`vague_non_actionable`, `identifier_in_prose`, `unsourced_claim`, `evidence_not_in_reason`,
`unresolvable_evidence`, `malformed_evidence_graph`, `claim_kind_not_derivable`,
`recommendation_mismatch`, `unknown_source_reason`, `stale_recommendation`,
`structurally_inadmissible`.

**The unsafe pressure patterns are covered explicitly**: `coercive_pressure` (removes the option to
decline; provokes #39's `COERCIVE_PRESSURE`), `shaming_language` (`SHAMING_LANGUAGE`),
`urgency_escalation` (manufactured urgency below the coercion line — provokes **no** #39 code, which
is the point: it is the pressure a blocking gate does not see) and `blame_adjacent_language`. Each in
all three locales.

## 7. The seam with #39, as a named partition

`lib/safety/**` is #39's and is not imported here. Instead each category records the #39 codes a
gateway *should* report for it, and `EXCLUDED_SAFETY_CODES` names every code this corpus cannot
provoke together with the reason. The test asserts the two sets **partition `SAFETY_REASON_CODES`
exactly** and do not overlap, so a code added to #39 without a decision here fails rather than
sitting unprobed.

Provoked today: `CLAIM_NOT_TRACEABLE`, `COERCIVE_PRESSURE`, `EVIDENCE_GRAPH_MALFORMED`,
`PERSISTENCE_CLAIMED`, `RAW_IDENTIFIER_DISCLOSED`, `SHAMING_LANGUAGE`, `UNKNOWN_CANDIDATE_SHAPE`,
`UNSOURCED_CLAIM`.

The categories that provoke **nothing** are the interesting ones. `evidence_not_in_reason` is the
defect #38's contract says Sprint 08's checkers structurally cannot find — every id in that row is a
valid node of a valid graph — and #39's gateway cannot find it either. Same for the three decision
echo categories: #39 never sees the plan, so it cannot know which verdict was acknowledged. A corpus
carrying only rows both gates catch would report an agreement it never measured.

## 8. Lock state is derived, and the tuning guard is structural

A row's lock state is `sha256(LOCK_ASSIGNMENT_VERSION + ' ' + rowId) % 100 < 20` and nothing else —
not a field, not iteration order, not a clock, not unseeded randomness. This is
`lib/decomposition/evaluation/splits.ts`' rule for its reason: a held-out set that moves between runs
is not held out, and a row's split is decided the moment it gets an id and never moves again.

The row still *carries* `lockState`, and `verifyLockState` reports `LOCK_STATE_MISDECLARED` when the
carried value disagrees with the derived one. The carried value is never what a consumer acts on: a
row relabelled `'open'` by hand still lands in the locked half, because membership is a function of
the id. The relabelling is visible *and* inert.

Two things replace a label check:

1. `partitionByLock` returns two **differently typed** wrappers, `TuningRowSet` and `LockedRowSet`,
   discriminated by a literal `kind`. `scoreTuningSet` takes the first and `runLockedEvaluation` the
   second, so handing over the wrong half is a type error at the call site rather than a filter
   someone has to remember.
2. `auditTuningSet` re-derives lock state on the way *in*, because a `TuningRowSet` can be built by
   hand and the type only stops the accident. It **reports** `LOCKED_ROW_IN_TUNING_SET` rather than
   throwing, on `COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames`' terms — and the report still
   comes back, because a refusal to report would hide the contamination rather than name it.

`runLockedEvaluation` carries `lib/priority/calibration/lockedGate.ts`' two refusals, checked before
anything is measured: `refused_already_used` (a second look at a held-out set is optimisation against
the test set performed one attempt at a time) and `refused_empty_corpus` (a report over zero rows
emits the same words a real one emits and certifies nothing). A refusal does not consume the id; a
successful run consumes it whatever the numbers say.

## 9. The generator, and the defect it shipped before review

`generateRows(seed, count)` derives every choice from `sha256(seed + ' ' + index + ' ' + field)`.
Counter-based, not stateful: the value for row 40 does not depend on whether rows 0–39 were produced,
so two processes on two machines agree without exchanging anything but the seed.
`tests/coaching/evaluationSet.test.ts` measures that **across processes**, by spawning a child and
comparing corpus digests — a same-process comparison cannot see a dependency on module load order or
anything else the runtime supplies.

**The correction worth recording.** The first version advanced category and locale by the same step.
Because the category count (21) is a multiple of the locale count (3), the two moved in lockstep:
every category was paired with exactly one locale, in every seed, forever. The generated half was
*structurally incapable* of producing two thirds of the pairs, and the measured coverage looked
complete because the **authored** half covered them. That is Sprint 08's recorded failure verbatim —
a generator that cannot produce the case that matters, behind numbers that clear every threshold.

Two changes followed. The generator now walks the (category, locale) cross product by a seeded
offset; and the coverage assertion runs on the **generated rows alone**, not on the union. A test
over the union would still pass today against the broken generator.

## 10. Measured distribution — the numbers, not a claim about them

Corpus `021c772408a1024cd095c6c323614c28febb072fcb7bb1dc0b4d885fb55f94e1`, seed
`coaching-eval-seed-1`, 120 generated rows.

| Figure | Value |
|---|---|
| Rows | 183 (63 authored + 120 generated) |
| Locales | 3, exactly `COACHING_LOCALES` |
| Adversarial categories | 21, exactly `ADVERSARIAL_CATEGORIES` |
| (category, locale) pairs | 63 of 63, on the generated half alone and on the whole corpus |
| Coaching intents produced | 6 of 6 |
| Coaching strategies produced | 5 of 5 |
| Claim source kinds produced | 5 of 5 (four evidence kinds plus `user_decision`) |
| Locked / tuning | 32 / 151 (17.5% locked) |

Tuning half (151 rows), automated report:

| Section | Figure |
|---|---|
| Admissible | 145 / 151 |
| Faithfulness gate held | 56 / 145 |
| ├ `claim_support` held | 94 / 145 |
| ├ `claim_derivability` held | 129 / 145 |
| ├ `decision_echo_integrity` held | 131 / 145 |
| └ `persistence_claim` held | 137 / 145 |
| Tone scored / withheld for faithfulness / withheld as inadmissible | 56 / 89 / 6 |
| `helpfulness` bands (fail / borderline / pass) | 15 / 5 / 36 |
| `calmness` bands | 7 / 9 / 40 |
| `non_shaming` bands | 6 / 7 / 43 |
| Gate matched expectation | 151 / 151 |
| Planted defect detected | 131 / 131 |
| Out of scope (`IDENTIFIER_IN_PROSE`) | 6 |
| Human | `not_collected` |

Locked half: 32 rows, measured once, 32 / 32 gate matches.

**These are not quality figures.** A faithfulness gate that holds on 56 of 145 rows is a statement
about a corpus 89 of whose rows were built to fail it. The two figures worth watching are
`expectation.gateMatched` and `expectation.attackDetected`: both are 1.0, and both would *drop* while
every other number in the report *improved* if the scorer stopped detecting a category. Sprint 06
recorded the same shape — a decomposer that refused all eleven golden rows scored a perfect
faithfulness.

## 11. The human slot

`HumanSection` is a two-variant union discriminated on `status`, and the `not_collected` variant
carries **no numeric field of any kind**. That is the required property expressed as a shape: "no
human scores yet" and "human scores were all zero" reach different variants, and the first has no
number in it to be mistaken for the second. `tests/coaching/scoringPipeline.test.ts` walks the
`not_collected` section recursively and asserts zero numbers are reachable from it.

`mergeHumanScores(report, humanScoreSet)` is the only way to reach `collected`, and an empty score
set returns the empty slot rather than a `collected` section full of zeros.

`humanScoringSlot()` carries the questions a reviewer is asked, read straight off `COACHING_RUBRIC`
rather than restated, so the report carries the instructions for filling its own gap and the two
cannot drift. The scale is `ToneBand`'s three values for every dimension, tone and faithfulness
alike; the automated faithfulness gate is binary and the human one is three-valued on purpose,
because a reviewer must be able to abstain and forcing that into held/violated makes an abstention
look like a verdict.

`agreementWithAutomated` is computed for tone dimensions **only**. The faithfulness gate is not a
proxy for a human judgement — it is the judgement — so a disagreement there is a defect in one side
rather than a calibration figure.

**Merging human scores never promotes the corpus to reviewed.** A report about rows is not a property
of the rows. Promotion needs a review log naming each row, its reviewer and a time, on
`verifyReviewedProvenance`'s terms (`lib/decomposition/evaluation/corpus.ts`), and that machinery is
not part of this pass.

## 12. What to do when a reviewer exists

The follow-up, in order:

1. Add a `human_reviewed` member to `AnnotationProvenance` and a `reviewed` member to
   `CorpusReviewStatus`, **in the same commit as** a review-log type and a
   `verifyReviewedProvenance` equivalent that refuses a row claiming review without a review row
   naming it, a reviewer and a time. Adding the member first is how a corpus starts claiming a review
   it never had.
2. Collect answers to `humanScoringSlot().questions` for a sample of the **tuning** half only. The
   locked half is the hold-out; reviewing it destroys what it is for.
3. Pass the result to `mergeHumanScores` and read `agreementWithAutomated`. If a tone dimension's
   agreement is low, the lexicon is the thing to fix, not the threshold — Sprint 08 recorded that
   lowering a threshold is how a suite reports a strength it no longer has.
4. Only then consider whether any tone figure is worth acting on. Today none of them is.

## 13. Migration and rollback

**There is no migration.** Nothing in this change writes, reads or persists anything. No file is
added to `data/`, no schema is versioned into storage, no API route is touched, no feature flag is
introduced, and no existing module imports any of this code. `lib/coaching/evaluation/` is a leaf:
it imports `src/contracts/v1/{coaching,recommendation,safety}Contracts.ts`,
`lib/planning/shared/compare.ts` and `lib/evaluation/registry/fingerprint.ts`, and nothing imports
it back.

**Rollback is `git revert` of the merge commit.** Nothing survives it: no data to reconcile, no
consumer to unwind, no stored artifact to delete. The only visible effect is that the three test
files go back to being absent, which is the state the sprint base already ships — they are not yet
registered in `package.json`, so `npm test` neither gains nor loses a case either way.

**Partial rollback** is safe at file granularity in one direction only: `scoring.ts` may be reverted
alone (nothing imports it), `evaluationSet.ts` may not be reverted without `scoring.ts`, and
`rubric.ts` may not be reverted without both.

**Forward compatibility, and which version string does what.** Three versions exist and they are not
interchangeable:

- `COACHING_RUBRIC_VERSION` — bump when a dimension, a band or a code disposition changes. A stored
  report carries it, so a report minted against an older rubric is identifiable rather than silently
  comparable.
- `COACHING_EVALUATION_SET_VERSION` — inside `corpusDigest`, so it re-points every digest. Bump when
  the row *shape* changes, not when a row's content does; the digest already makes a content change
  visible on its own.
- `LOCK_ASSIGNMENT_VERSION` — inside the lock digest, so bumping it **re-points every row's lock
  state**. It exists to make a deliberate re-split possible and cannot happen by accident. Do not
  bump it for anything else: a maintainer who bumps it for a one-line fix has silently un-held the
  entire hold-out.

`corpusDigest` is taken over the row *set*, sorted by id, so reordering rows is not a change to the
corpus and a stored digest will not spuriously mismatch. `provenance` and the derived `lockState` are
inside it, so a corpus relabelled from synthetic to anything else is a *different* corpus and a
report minted against the old label refuses to match the new one — the reason
`lib/priority/calibration/corpus.ts` puts provenance inside its digest.

## 14. Open risks

- **This module implements a faithfulness check #38's `lib/coaching/validator/` will also implement.**
  `checkCoachingFaithfulness` emits #38's `CoachingFaithfulnessDefectCode`s and invents none of its
  own, so replacing its body with a delegation is a one-line change when #38 lands. Until then the
  two are a second reading of one judgement, which Sprint 06's lesson permits only *when something
  compares them* — the cross-track comparison is the merge's to write, and this file's job is to be
  comparable, which is why it emits codes rather than booleans.
- **`CLAIM_KIND_FOR_NON_SUPPORT_SOURCE` is #37's own reading.** #38's
  `CLAIM_KIND_FOR_SUPPORT_REASON` is total over `SupportReasonCode` and says nothing about the other
  three claim-source kinds. This table decides them, is disjoint from #38's (that one is keyed by
  reason code, this by source kind), and is stated in one place so a reviewer can disagree with it
  there.
- **The locked half holds 32 rows and does not cover every category.** Lock assignment is a digest of
  the row id and is not tuned, so which categories land in the hold-out is not chosen. The remedy is
  more rows, never hand-picked ids — Sprint 06 recorded the same limitation for its locked-test split
  and the same remedy.
- **Every tone figure is a lexicon match.** Nothing in this pass measures whether a sentence is
  helpful, calm or non-shaming to a person. That is what §11 exists for, and until it happens no tone
  figure here should appear in any document that does not also carry this sentence.
