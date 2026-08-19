# Decomposition Annotation Guide

Sprint 06, [issue #26](https://github.com/anasakkari3/maybesitter/issues/26).
Design: `docs/superpowers/specs/2026-08-19-sprint-06-decomposition-design.md`, Component 2.
Contracts: `src/contracts/v1/decompositionContracts.ts` (committed before this work started, and not
modified by it).

## 0. Status — the corpus ships synthetic and the reviewed corpus ships empty

**`data/quality/decomposition-reviewed-examples.json` contains zero rows, and every row in
`data/quality/decomposition-seed-examples.json` is `provenance: 'synthetic'`.**

The issue title asks for a *reviewed* dataset. The scope split committed on the issue says the
review itself is a stub, and the split wins: the annotation guidance, the queue, ingest, the
deterministic checksum-protected splits and the three metrics are buildable now; **the human
approval is not**, because no reviewer exists.

This is the call Sprint 04 made for `data/quality/priority-judgments.json` and Sprint 05 kept for
`data/quality/priority-annotation-decisions.json`, for the same reason. A dataset that claims review
it never had corrupts every number computed from it afterwards, and does so invisibly: a metric
fitted to fabricated labels looks exactly like a metric fitted to real ones, and there is no later
inspection that tells them apart.

Two tests enforce it, in `tests/decomposition/datasetCorpus.test.ts`:

- `the reviewed corpus ships empty` closes **both exits** — valid rows would pass a validity check,
  so the row count is asserted separately and against the raw file rather than the loader's output;
  invalid rows would make the count zero for the wrong reason, so validity is asserted too.
- `a human_reviewed row without a reviewer record does not verify` makes the claim *checkable*
  rather than conventional. `verifyReviewedProvenance` requires a review row naming the example, a
  reviewer and an ISO timestamp, and `promoteToReviewed` throws without one — so the first reviewed
  row has to arrive in the same commit as the evidence for it. §6 is how to do that.

**Nothing computed from the seed corpus is evidence about model quality.** The corpus exists to
prove the pipeline runs.

## 1. What is here

| Module | Purpose |
|---|---|
| `lib/decomposition/evaluation/example.ts` | Validates one labelled example against the shared `DecompositionViolationCode` vocabulary. |
| `lib/decomposition/evaluation/splits.ts` | Digest-based train / valid / locked-test assignment, the sealed manifest, and its verifier. |
| `lib/decomposition/evaluation/metrics.ts` | Boundary, coverage and semantic-faithfulness scores, each with its denominator. |
| `lib/decomposition/evaluation/corpus.ts` | Corpus files, the review queue, review ingest, conflict retention, provenance verification. |
| `lib/decomposition/evaluation/index.ts` | Barrel. |

| Artifact | Contents today |
|---|---|
| `data/quality/decomposition-seed-examples.json` | 23 synthetic examples. `role: "seed"`. |
| `data/quality/decomposition-reviewed-examples.json` | **Empty.** `role: "reviewed"`. |
| `data/quality/decomposition-annotation-reviews.json` | **Empty.** The reviewer decisions. |
| `data/quality/decomposition-split-manifest.json` | Sealed split: 12 train / 3 valid / 8 locked-test. |

Seed composition: 10 `multi_step`, 7 `do_not_split`, 6 `atomic`; 10 `en`, 5 `ar`, 5 `he`, 3 `ar-EN`.
`do_not_split` is deliberately over-weighted for the reason the golden set is: over-splitting is the
failure that survives a green suite, because a splitter firing on every conjunction scores well on
the multi-step rows and only shows its damage where firing is wrong.

The evaluator does **not** import `tests/fixtures/decompositionGolden.ts`. The golden set is ground
truth the evaluator is exercised against in tests, not data it depends on; a production module that
cannot start without a test file is a production module that ships its tests.

---

## 2. How to label an example

An example is one commitment sentence plus the decomposition a correct engine would produce for it.

### 2.1 Pick the label first

| Label | Means | Test to apply |
|---|---|---|
| `multi_step` | The sentence states **two or more distinct actions**. | Could a person do one of them and not the other, and would each still be a task on its own? |
| `atomic` | One action. | There is nothing to cut. A deadline, an owner or a location is not a second action. |
| `do_not_split` | The sentence *looks* splittable and must not be split. | A conjunction is present, and cutting on it produces something the user never described. |

`atomic` and `do_not_split` are both "one step", and they are different labels because they fail
differently. `atomic` says there is no cue to mislead a splitter; `do_not_split` says there is one
and it is a trap. Merging them would let a corpus be 100% "unsplittable" while containing no case
that actually tests restraint.

Both carry `expectedSteps: []`. A row labelled `multi_step` must carry **at least two** steps: a
step list of size one and an honest refusal to decompose are the same data, and the contract removes
that ambiguity on the proposal side by giving `AtomicProposal` no `steps` field at all.

The two directions are reported under **different** codes, and the distinction matters for the
cross-track comparison with #27:

- An `atomic` or `do_not_split` row carrying steps is `SPLIT_ATOMIC`, from the shared vocabulary.
  This is the over-split direction, and it is the only thing the contract's `SPLIT_ATOMIC` means.
- A `multi_step` row carrying fewer than two steps is `DXC031`, on
  `ExampleValidationResult.corpusIssues`, in this module's own namespace. #27 **cannot** produce
  that shape — `DecomposedProposal.steps` is typed `[Step, Step, ...Step[]]`, so a sub-two-step
  decomposition is unrepresentable — and a shared code that one track can emit and the other never
  can is a cross-track disagreement waiting to be found over data neither side thinks is broken.

### 2.2 Write the spans, do not count them

A `SourceSpan` is a half-open `[start, end)` range in **UTF-16 code units** over the original text,
carrying the text it selects. `sourceText.slice(start, end) === span.text` must hold, and the
validator checks it by slicing rather than by reading `span.text` back — a forged span is exactly a
span whose carried text disagrees with its offsets, so a validator that trusts the text cannot see
the forgery it exists to catch.

Locate snippets with `indexOf` (as `tests/fixtures/decompositionGolden.ts` does) rather than
hand-counting offsets. Hand-counting across Arabic, Hebrew and Latin text is a source of silent
error, and an `indexOf` helper that throws on an ambiguous snippet turns a coin flip into a failure.

Right-to-left needs **no special handling**. Arabic and Hebrew render RTL, but storage order is
logical, so a span over an RTL clause is an ordinary increasing range. Bidi is a rendering problem
and spans are not rendering.

Rules for the span set:

- **Exact.** The span is the step, not the step plus its punctuation, and not the step plus the
  conjunction that preceded it. In `احجز التذكرة ثم جدد جواز السفر واشتر التأمين.` the third span
  starts at `اشتر`, **not** at the prefixed `و` — including the clitic would be including the
  boundary marker inside the thing it separates.
- **Non-overlapping, full stop.** No two spans in an example may claim the same code units —
  including two spans of the *same* step. Checked pairwise over every span; reported as
  `SPAN_OVERLAP`. Adjacent is fine — `[0,4)` and `[4,10)` do not overlap. A step double-claiming its
  own text is the case that hides best: `coveredCodeUnits` unions the duplication away, so no
  coverage figure moves and nothing else would ever notice.
- **Disjoint spans on one step stay legal.** That is why `sourceSpans` is a list at all.
- **Not required to cover everything.** Connectives, punctuation and scheduling phrases sit outside
  every span. That is why coverage on a perfect decomposition is well under 1.0, and why the
  coverage metric reports the ground-truth figure beside the produced one.
- **A list may be discontinuous.** `sourceSpans` is an array because one step is often stated across
  separate parts of a sentence.

### 2.3 Never invent a fact

`statedTiming` and `statedOwner` must occur **verbatim** in the source text, or be `null`.

- Write `"by Friday"`, `"يوم الاثنين"`, `"before June"` — whatever the sentence says.
- Never write `"2026-08-21"`. Resolving a relative time against a clock is Capture's job; a
  decomposer that computes one has invented a fact. Reported as `INVENTED_TIMING`.
- Never infer an owner from context — only from a name the sentence contains. Reported as
  `INVENTED_OWNER`.
- Never write `""`. An empty string is neither a claim nor an absence, and `indexOf("")` is `0`, so
  a blank "occurs verbatim" in every source text ever written and would sail through the check. The
  field already has a way to say nothing: `null`. A blank is reported as `INVENTED_TIMING` /
  `INVENTED_OWNER`.

A step with no span must set `inferred: true` and admit it. A step that claims inference *and* cites
text is `INFERRED_WITH_SPAN`.

**`UNSOURCED_STEP` has two shapes, and the second is the one that is easy to miss:**

1. A step with **no span at all** that does not admit to being inferred. It is indistinguishable
   from an invented one.
2. A step whose **spans do not source its `title`**. The title must be what its spans cover — equal
   to the spanned text, or the concatenation of it across disjoint spans — unless `inferred` is true.

Shape 2 is what a hostile or hallucinating provider produces: a span that round-trips perfectly
beside a title that was never in the text — a clean citation of "Book the venue" under the title
`Wire $9,000 to account 12345`. It passes exactness, range, overlap, timing and owner, because every
one of those interrogates the *span* and none interrogates the claim the span is offered in support
of. #27 found the hole from the adapter side; the code is shared, so the check is too, or the
evaluator would score a corpus clean that the validator rejects.

Two deliberate exemptions, each because the defect is already named and a second code would send you
looking in the wrong place: a **blank** title is `EMPTY_STEP`, and a step carrying an **unusable**
span (failed range or exactness) has no trustworthy text to be judged against at all.

Whitespace is not provenance: the comparison collapses whitespace runs and trims, so a title spanning
a comma-and-space gap in the source is sourced by the two spans either side of it.

### 2.4 Record only the dependencies the text states

`dependsOn` is for edges the sentence asserts. "then", "وبعدها", "ואז" and genuine
prerequisite chains ("print, sign, send") are real. A bare "and" between two steps orders nothing,
and writing an edge there invents a constraint Sprint 07's scheduler will act on.

`kind` distinguishes `temporal` (must follow), `resource` (contend for the same thing) and
`informational` (needs the other's output). It is typed now because an untyped edge cannot tell a
scheduler whether two steps are sequential or merely share a resource.

Self-edges are `SELF_DEPENDENCY`; edges to a step that is not in the list are `UNKNOWN_DEPENDENCY`;
a cycle is `CYCLIC_DEPENDENCY` (a self-edge is reported only as the former — one defect, one code).

### 2.5 Write the `note`, especially on `do_not_split`

`note` is required on every row. On a `do_not_split` row it is the entire content of the label: state
**what a naive splitter would produce and why that is wrong**. "and sits inside the noun phrase
'terms and conditions'; splitting yields 'Review the terms' and 'conditions before Friday', the
second of which is not even an action" is a note. "Do not split" is not.

---

## 3. Splits

`assignSplit(exampleId)` hashes `"decomposition-split-v1:<exampleId>"` with SHA-256, takes the first
32 bits, and buckets it 0–99 against weights 70 / 15 / 15.

Assignment is a function of **the id and nothing else** — not iteration order, not a clock, not
unseeded randomness. Each of those produces a different held-out set on each run, and a held-out set
that changes between runs is not held out, it is a sample.

The alternative that looks better and is worse: sorting by digest and cutting at quantiles. That
gives exact proportions and re-points the locked set every time an example is added, because every
row's rank moves. A per-id bucket gives approximate proportions — which is why 23 rows land 12 / 3 /
8 rather than 16 / 3 / 4 — and the property that actually matters: **a row's split is decided the
moment it gets an id and never moves again.** Do not "rebalance" the split by tuning ids.

Weights are pinned to `DEFAULT_SPLIT_WEIGHTS` at verification time (`DSM025`), for the same reason
`assignmentVersion` is: weights decide the partition just as much as the hash does, and a manifest
sealed with `{100, 0, 0}` has no locked-test split at all while describing itself as split three
ways. Re-weighting is a re-split, and a re-split needs a new assignment version rather than a quiet
reseal. `buildSplitManifest` still accepts custom weights — that is a testing affordance, and a
manifest built with them will correctly refuse to verify.

`data/quality/decomposition-split-manifest.json` seals membership *and* content. Membership alone
cannot catch an edit to a row's `sourceText` that leaves its id intact, and that edit changes what a
locked-test score means while changing nothing a reviewer would notice in a diff of counts. The
per-split and whole-corpus checksums are what close it.
`tests/decomposition/datasetCorpus.test.ts` re-verifies the sealed manifest against the committed
corpus on every run, so the two cannot drift apart silently.

**Unlike the Priority queue, nothing is withheld from review here.** Sprint 05 withholds its locked
split because a judgment on a locked pair is the signal the policy is *fitted* to. The direction is
opposite in this track: review produces the ground-truth **labels**, and a locked-test split nobody
labelled is not a test set at all. What must not happen here is an edit after sealing, which is the
manifest's job, not a queue filter. Copying the Priority rule across would have left the held-out
split permanently unlabelled.

---

## 4. The three metrics

Every score is a `MetricScore` carrying `value`, `numerator`, `denominator` and `denominatorOf` — a
sentence naming what the denominator counts. A faithfulness of 1.0 over 3 of 40 examples and one
over 40 are different claims that become the same claim the moment the value is copied without the
count, and the smaller one is the one that flatters. A ratio over an empty denominator is `null`,
never `0`: zero is a measurement, an empty denominator is the absence of one.

| Metric | Question | Denominator |
|---|---|---|
| `boundary.spanRecall` | Did it find the cuts the ground truth states? | Expected spans in the evaluated examples. |
| `boundary.spanPrecision` | Are the cuts it made ones the ground truth agrees with? | Spans the proposals produced. |
| `boundary.exactExampleAgreement` | Whole-row agreement, refusals included. | Evaluated examples. |
| `coverage.produced` | How much source text do the produced steps account for? | Source code units across the **decomposed** proposals. |
| `coverage.groundTruth` | The same figure for ground truth. **Not a ceiling** — see below. | Source code units across the examples carrying **expected spans**. |
| `faithfulness.clean` | Did it avoid inventing, mis-citing and over-splitting? | Evaluated examples **whose proposal produced at least one step**. |
| `faithfulness.doNotSplitRespected` | Did it leave the unsplittable rows alone? | Evaluated `do_not_split` + `atomic` rows. |

Three choices worth stating, because each could reasonably have gone the other way:

- **Boundary matches on offsets alone.** Whether a span's carried `text` is really what those offsets
  select is `SPAN_MISMATCH`, counted under faithfulness. Folding it into boundary would report a
  forged span as a misplaced cut, which is the wrong repair to go looking for.
- **Coverage is a union, and only over decomposed rows.** Summing span lengths would let a
  decomposer reach 100% by emitting the same step twice. Including refusals at zero would understate
  a decomposer that is correctly conservative — so refusals are excluded and `examplesInScope`
  reports how many rows the figure actually covers.
- **`coverage.groundTruth` is not a ceiling on `coverage.produced`, and must not be described as
  one.** It was called `coverage.expected` and was computed over the *decomposed* rows, which made
  it read `0.0000` on a do-not-split row an over-splitter had split, while `produced` read `0.8696`
  on the same row — the "ceiling" beneath the figure it supposedly bounded, and the over-splitter
  posting the highest coverage number in the report. The two now carry different scopes and each
  states its own in `denominatorOf`. Read them side by side; do not subtract them.
- **Under-splitting is not an invention, and not a clean bill either.** A proposal with no steps is
  scored as a boundary miss and left out of faithfulness — out of **both halves of the ratio**.
  Charging it to faithfulness would make "declined to answer" and "fabricated a date" the same
  finding. But leaving it in the denominator was worse in the other direction: an empty proposal
  produces no violations, so it landed in the *numerator* too, and a decomposer that refused all
  eleven golden rows scored `clean = 1.0 (11/11)` — identical to a flawless run. It now scores
  `clean = null (0/0)` with `boundary.spanRecall = 0.0 (0/11)`, which is the honest picture.

`FAITHFULNESS_VIOLATION_CODES` is the subset of the shared vocabulary that is a claim about the
world: `SPAN_MISMATCH`, `INVENTED_TIMING`, `INVENTED_OWNER`, `UNSOURCED_STEP`, `INFERRED_WITH_SPAN`,
`SPLIT_ATOMIC`. `EMPTY_STEP`, `CONJUNCTION_ONLY`, `DUPLICATE_STEP_ID`, `SPAN_OVERLAP`,
`SPAN_OUT_OF_RANGE` and the dependency codes are excluded: each is a malformed proposal rather than
a dishonest one, #27 rejects them outright so they never reach a user, and counting them here would
make a decomposer that emits garbage look like one that lies.

Typical run:

```ts
import { loadSeedCorpus } from './lib/decomposition/evaluation/corpus';
import { selectSplit } from './lib/decomposition/evaluation/splits';
import { buildEvaluationReport } from './lib/decomposition/evaluation/metrics';

const held = selectSplit(loadSeedCorpus().examples, 'locked-test');
const report = buildEvaluationReport({
  examples: held,
  proposals: await runYourEngineOver(held),   // commitmentId === exampleId
  generatedAt: '2026-08-19T12:00:00.000Z',    // the caller owns the clock
});
```

### Reading a report honestly

`faithfulness.doNotSplitRespected` is `1.0 (7/7)` for a decomposer that refuses everything, and that
is **correct**, not a defect: it did leave every unsplittable row alone. The metric answers one
narrow question and answers it truthfully. It is only misleading if read alone, which is why
`clean` and `spanRecall` sit beside it — a total refuser reads `null (0/0)` and `0.0 (0/11)` there,
and no reader who looks at the row can mistake it for a good result.

No module under `lib/decomposition/evaluation` reads `Date.now`, `new Date` or `Math.random`; a test
in `tests/decomposition/datasetCorpus.test.ts` enforces it by reading the sources. These reports are
committed artifacts, and one that differs between two runs over unchanged input cannot be reviewed
as a diff.

---

## 5. The review queue

`buildDecompositionQueue({ examples, enqueuedAt })` produces one `DecompositionQueueItem` per
example, ordered by id, with the supplied timestamp and a deterministic `dq_`-prefixed id. Two runs
over an unchanged corpus produce byte-identical output, which is what makes a batch exportable,
reviewable offline and re-importable as the same batch.

A reviewer answers with a `DecompositionReview`:

| Verdict | Means | `label` |
|---|---|---|
| `approve` | The row is correct as labelled, spans included. | `null` |
| `relabel` | The label is wrong; here is the right one. | required |
| `reject` | The example should not be in the corpus — the source text is unusable. | `null` |
| `unresolved` | Abstention. The guide does not decide this case. | `null` |

**Only `approve` is evidence that a row may be stamped `human_reviewed`.** `reject` says the row is
unusable — reading it as approval would certify the exact row the one person who looked at it threw
out. `unresolved` is an abstention, and someone who abstained is precisely someone who did not judge
the row. `relabel` is evidence **only for the label the reviewer proposed**: promoting a row the
relabel has not been applied to would stamp `human_reviewed` on the label the reviewer rejected and
silently discard the one they asked for.

**`spansVerified` is load-bearing.** An approval certifies the whole row, spans included; a reviewer
who did not look at them has not certified them, so an `approve` filed with `spansVerified: false`
is not evidence for a row that carries spans. A row with no spans — every `atomic` and
`do_not_split` row — has nothing to verify and needs no attestation; demanding one about nothing is
how a checkbox becomes a reflex.

One predicate, `isBackingReview`, decides all of this for both `verifyReviewedProvenance` and
`promoteToReviewed`. They were separate and had already drifted — the minter refused an abstention
while the verifier accepted one, and since the verifier is the half wired into the shipped-file
guard, the laxer of the two was what actually ran. The predicate also re-runs
`validateDecompositionReview` over every candidate: a bare object literal carrying four plausible
fields and no `version`, `reviewId` or `rationale` used to mint a reviewed row, because nothing
validated the evidence before counting it as evidence.

### Three layers, because one is one bypass away

The honesty guarantee is enforced at every level a caller can enter at, not only the outermost:

| Entry point | What it enforces |
|---|---|
| `isBackingReview` | What counts as evidence at all: verdict, structure, span attestation. |
| `parseExampleCorpus` | Provenance, over whatever evidence the caller supplies — defaulting to **none**. |
| `loadSeedCorpus` / `loadReviewedCorpus` | That the file is the corpus you asked for (`DXC022`), plus everything above. |

`parseExampleCorpus` defaults its `reviews` to empty rather than reading the shipped review log. That
keeps the parser pure, and it makes "no evidence supplied" the failing case rather than the quiet
success — a caller who wants a reviewed row to pass has to hand over the evidence for it.

The role check is separate from the row-level `DXC020`/`DXC021` checks and neither substitutes for
the other: those are about what a row claims, `DXC022` is about which file you opened.
`loadReviewedCorpus` pointed at the seed file used to return all 23 synthetic rows and call them
valid, because `verifyReviewedProvenance` skips every row that is not `human_reviewed` — a file with
no reviewed rows sails straight through the check meant to police reviewed rows.

`reject` and `relabel` are separate because merging them would make "this row is mislabelled" and
"this row should not exist" the same edit, and only one of them changes the size of the corpus.
`spansVerified` records whether the reviewer actually checked each span against the source text by
hand, which is a different act from agreeing with the label.

`createDecompositionReview` is the only constructor and requires `reviewerId` and `reviewedAt`; it
writes every field explicitly rather than spreading its input, so a forged `version` riding along on
the caller's object has nowhere to land. `validateDecompositionReview` enforces the same
requirements on anything arriving from outside the process, because a type does not survive a
`JSON.parse` or a hand-edited file.

### Ingest

`ingestReviews(rows, { queue, existing })` applies three refusals, each returned with a code rather
than dropped, because a row that vanishes without a reason is a row a maintainer will resubmit
unchanged:

1. `MALFORMED_REVIEW` — shape and provenance. Nothing downstream can be decided about a row whose
   `exampleId` is not a string.
2. `UNKNOWN_EXAMPLE` — a verdict about a row nobody defined refers to nothing.
3. `DUPLICATE_REVIEW` — refused per **(example, reviewer)**, not per row id. Two submissions from one
   person are not two data points, and accepting both weights that person's opinion by however many
   times they pressed send. Duplicates are caught across sessions via `existing`.

### Conflicts: computed, retained, never resolved

Two reviewers who disagree produce two accepted rows and one reported `DecompositionReviewConflict`.
Collapsing them to a majority would delete the only signal that says **this guide is ambiguous**,
which is the thing a guide gets revised from.

`unresolved` is excluded from conflict detection and counted separately, exactly as Sprint 04's
agreement report excludes abstentions from its denominator: an abstention is neither agreement nor
disagreement, and treating it as a conflict pushes a reviewer to guess rather than abstain.

---

## 6. How a future maintainer runs a real annotation round

1. **Build and export the queue** with an explicit `enqueuedAt`. Hand reviewers the items, the
   source text for each, and §2 of this document.
2. **Collect reviews.** At least two reviewers per example, or the conflict machinery measures
   nothing. Each row needs a real `reviewerId` and the ISO time the person actually decided.
3. **Ingest** with `ingestReviews`. Read `rejected` and `issues` before reading `accepted`. Read
   `conflicts` before doing anything else: a conflict rate above a few percent means §2 is
   under-specified, and the fix is to revise §2 and re-review, not to pick a winner.
4. **Write the review log** to `data/quality/decomposition-annotation-reviews.json`. This commit is
   where the names and times enter the repository.
5. **Promote approved rows** with `promoteToReviewed(example, reviews)` into
   `data/quality/decomposition-reviewed-examples.json` (`role: "reviewed"`). The function throws
   without an `approve` review, so a promotion cannot outrun its evidence. **Apply `relabel` verdicts
   to the row before promoting it** — `promoteToReviewed` refuses a row whose label still contradicts
   the relabel, and says so by name. Drop `reject`ed rows; leave `unresolved` rows in the seed corpus.
6. **Update the two guard tests.** `the reviewed corpus ships empty` will fail, correctly, the moment
   real rows land. Replace the zero assertion with the new expected count *and keep both exits
   closed* — assert validity separately, and keep asserting that every `human_reviewed` row verifies
   against the review log. Do not delete the guard; narrow it. Note that `loadReviewedCorpus` now
   enforces provenance on the **load path** as well, so narrowing this test no longer leaves the
   claim unchecked — but the test is still what makes the guarantee visible in review.
7. **Re-seal the split manifest.** Promoting a row changes the corpus content, so the checksums
   change. Rebuild with `buildSplitManifest` and commit the result in the same commit as the data.
   Membership will not change: split assignment is by id, and promotion does not change ids.
8. **Consider upgrading the manifest to a chain ledger.** `lib/evaluation/registry/lockChain.ts`
   makes a lock append-only, so a maintainer cannot rewrite a sealed row in place to match an edited
   corpus. Sprint 06 deliberately ships a single sealed checksum instead: with no reviewed rows the
   corpus is rebuilt from source on every run, and the chain would be ceremony. Once real reviewed
   rows exist, that stops being true and the chain earns its weight.

---

## 6a. Known limitations

Stated here rather than discovered later. None of these is a defect in the code; each is a
consequence of the corpus being 23 synthetic rows.

### The locked-test split cannot answer the boundary question

Per-id hashing put **one** multi-step row in the held-out split. So on locked-test:

| Figure | Denominator today | Usable? |
|---|---|---|
| `faithfulness.doNotSplitRespected` | 7 rows (4 `do_not_split`, 3 `atomic`) | **Yes** — this is what the held-out split is currently for. |
| `faithfulness.clean` | 1 row | No. One row is an anecdote. |
| `boundary.spanRecall` | 3 spans, all from one sentence | No. |
| `coverage.produced` | 1 row | No. |

`tests/decomposition/evaluatorPipeline.test.ts` asserts this composition explicitly, so the
limitation cannot quietly drift. That test is expected to be **updated** when the corpus grows, not
deleted.

**The remedy is more seed rows — never ids tuned to move existing rows between splits.** A row whose
split moves was never held out, and hand-tuning ids to "fix" the balance destroys the one property
the digest scheme exists to provide. Adding rows is safe precisely because assignment is per-id:
existing rows do not move.

### Every number in this pipeline is a property of the pipeline

The seed corpus is synthetic and the proposals in the test suite are reconstructed from ground
truth, so every score in every test is a ceiling the pipeline can reach, not a measurement of any
decomposer. Nothing here is evidence about model quality, and a figure lifted out of this track into
a status report is a fabrication regardless of how it was computed.

---

## 7. Migration and rollback

**Migration: none required.** Everything this track adds is additive and unrouted:

- No stored-state migration. `DomainState` is unchanged, `src/contracts/v1/decompositionContracts.ts`
  was committed before this work and is not modified by it, and no existing file is edited.
- No production consumer. Nothing under `lib/decomposition/evaluation` is imported by an API route, a
  worker or a UI surface. It is reachable only from tests and from a future evaluation CLI.
- No user data is read or written. The corpora are engineering artifacts under `data/quality/`,
  written by hand and by test, and they contain no user text.
- `package.json` is not modified by this track. Test wiring is owned centrally at merge time, so the
  suites here run by explicit path until then (§8).

**Rollback: revert the commit.** There is nothing to undo in user state because nothing was written
to it. Concretely:

| Artifact | On revert |
|---|---|
| `lib/decomposition/evaluation/**` | Deleted. No importer outside `tests/decomposition/` exists. |
| `data/quality/decomposition-*.json` | Deleted. The reviewed corpus and the review log are empty, so no evidence is lost. |
| `tests/decomposition/*.test.ts` | Deleted with the modules they cover. |
| This document | Deleted. |

**Rollback once real reviews exist** is different and needs stating now, while it is cheap. The
review log is the only irreplaceable artifact in this track: the seed examples can be rewritten and
the manifest can be rebuilt, but a reviewer's judgement cannot be reconstructed. Before reverting
anything after step 4 of §6, copy `data/quality/decomposition-annotation-reviews.json` out of the
revert. A reverted review log costs a re-run of the whole annotation round.

**Forward compatibility.** `SPLIT_ASSIGNMENT_VERSION` (`decomposition-split-v1`) is part of the
hashed input, so re-splitting the corpus is possible but cannot happen by accident: it requires a new
version string, and a manifest sealed under the old one then refuses to verify (`DSM010`) rather than
silently describing a different partition. The same holds for the weights (`DSM025`).
`DECOMPOSITION_CORPUS_CONTRACT_VERSION` does the same for the data files.

---

## 8. Tests

Run by explicit path — `package.json` is owned centrally at merge time:

```
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/decomposition/*.test.ts
```

| File | Covers |
|---|---|
| `tests/decomposition/datasetExamples.test.ts` | Every violation code, both `UNSOURCED_STEP` shapes, span exactness by slicing, the audit-policy rule that no detail carries raw user text. |
| `tests/decomposition/splitsDeterminism.test.ts` | Determinism, order-independence, leak-freedom, and that a mutated corpus fails the sealed checksums. |
| `tests/decomposition/evaluatorMetrics.test.ts` | The three metrics and their denominators, run over `DECOMPOSITION_GOLDEN`. |
| `tests/decomposition/evaluatorPipeline.test.ts` | The seam: shipped corpus → split → report, and that the locked split shares no row with train or valid. |
| `tests/decomposition/datasetCorpus.test.ts` | The empty-corpus guards, provenance verification, the queue, ingest, conflict retention, and the no-clock rule. |

The cross-track test that checks this evaluator against #27's validator is
`tests/decomposition/decompositionCrossTrack.test.ts`, owned at merge time by neither track — a check
owned by the thing it checks is not a check.
