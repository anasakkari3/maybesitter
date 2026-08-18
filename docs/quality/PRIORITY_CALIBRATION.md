# Priority Calibration Pipeline

Sprint 05, issue [#22](https://github.com/anasakkari3/maybesitter/issues/22).
Design: `docs/superpowers/specs/2026-08-19-sprint-05-priority-calibration-design.md`.

---

## 1. Status: the machinery is built, the weights did not move

`data/quality/priority-judgments.json` holds **zero rows**. Sprint 04 shipped it empty on purpose,
so that Sprint 05 could not fit the product's ranking to preferences nobody expressed.

So this sprint built and exercised the pipeline and **did not change `DEFAULT_PRIORITY_POLICY`**.
Running `scripts/priority-calibrate.ts` today prints `Status: CORPUS EMPTY` and a refused gate. That
is the correct output, not a failure.

The separation is structural rather than procedural, because procedure cannot carry it. Weights
fitted to invented judgments look exactly like weights fitted to real ones — same shape, same
plausibility, no tell — so a rule that depended on the operator noticing which kind they held would
fail silently and look like success. Hence:

- `CalibrationReport.policyUnchanged` is typed as the **literal `true`**. A `boolean` could be set to
  `false` by a future caller who thought they were being helpful.
- `runCalibration` takes the base policy as a **value**, imports no writer, and returns a report. It
  has no write path to return through.
- The run fingerprints the base policy before and after the sweep and throws if it moved, so "the
  sweep did not mutate the shipped policy" is a checked fact rather than a claim about spread
  discipline.
- `tests/priority/policyFreeze.test.ts` (added centrally at merge) pins the shipped weights value by
  value. Shipping a calibrated weight is a human edit to `lib/priority/priorityPolicy.ts` *and* to
  that test — visible in review, never a quiet diff in a data file.

---

## 2. What the pipeline does

| Step | Module | What it produces |
|---|---|---|
| Corpus + digest | `lib/priority/calibration/corpus.ts` | `CalibrationCorpus`, a content-addressed digest |
| Objective | `lib/priority/calibration/concordance.ts` | `ConcordanceMetric` + per-slice + per-pair outcomes |
| Filter | `lib/priority/calibration/constraints.ts` | `ConstraintViolation[]`, and therefore `admissible` |
| Search | `lib/priority/calibration/sweep.ts` | 44 candidate policies, in a seeded visit order |
| Run + replay | `lib/priority/calibration/calibrate.ts` | `CalibrationReport`, `CalibrationManifest` |
| Final gate | `lib/priority/calibration/lockedGate.ts` | `LockedGateResult` + the used-split ledger |
| Rendering | `lib/priority/calibration/markdown.ts` | The human-readable report |
| Seed corpus | `lib/priority/calibration/seedCorpus.ts` | A corpus built from the Sprint 04 seed set |
| CLI | `scripts/priority-calibrate.ts` | Two report files, and nothing else |

### 2.1 The objective: pairwise concordance

The fraction of judged pairs whose ordering a candidate policy reproduces.

**`unresolved` verdicts leave the denominator entirely** — neither concordant nor discordant —
exactly as `lib/priority/rubric/agreementReport.ts` excludes them from observed agreement. Counting
an abstention as concordant makes a corpus of abstentions score 100%; counting it as discordant
punishes a reviewer for following the rubric.

Because the figure is computed over a subset, **its coverage travels with it**. `ConcordanceMetric`
carries `scorablePairs` and `unscorablePairs` next to `rate`, and `rate` is `null` — never a silent
`0` — when nothing was scorable. Zero is a measurement of total disagreement; the absence of data is
not that.

Two further exclusions, for the same reason:

- **Conflicting verdicts.** Reviewers who disagree have not produced a target ordering; they have
  produced evidence that the rubric is ambiguous there. A majority vote would manufacture a target
  nobody held and then score the policy against it.
- **Unknown pairs.** A judgment naming a pair the corpus lacks is counted as unscorable rather than
  dropped, so it shrinks the coverage figure instead of silently shrinking the denominator.

The unit is the **pair**, and the universe is the union of the corpus's pairs and the pairs somebody
judged — so two judgments over a forty-pair corpus render as "over 2 of 40", not "100% over 2 of 2".

### 2.2 Hard constraints are a filter, not a term

A candidate that reorders a constrained pair is `admissible: false` and is **rejected outright**,
regardless of how much its aggregate concordance improved.

A weighted penalty has a price, and any candidate whose aggregate gain exceeds that price buys the
violation. There is no number that makes inverting a commitment the user pinned an acceptable trade,
so there is no number in `constraints.ts`.

Two kinds are checked:

- **Structural pin** — one side is a high-importance commitment the user set themselves.
  `priorityScorer` marks it `HARD_CONSTRAINT_APPLIED` and `rankPriorities` places it in its own
  ordering tier, which **carries zero points**. No weight can invert it, so under the shipped ranker
  this check finds nothing by construction. It is kept for the day the comparator changes, or for a
  consumer that orders by `.total` instead of calling `rankPriorities` — which is what
  `lib/utils/agendaScoring.ts` does today.
- **Declared constraint** — a reviewer asserted via `ReviewedDecision.hardConstraintFlag` that a
  pair's ordering was forced. Nothing structural protects those, so weights can and do invert them.
  This is where the filter earns its keep, and it is the case
  `tests/priority/calibrationConstraints.test.ts` constructs deliberately: a candidate that lifts
  aggregate concordance from 1/3 to 2/3 *and* inverts a constrained pair, rejected anyway.

Pinned-ness is read off `PriorityScore.reasonCodes` — the scorer's own statement — rather than
re-derived from the feature vector, so there is only one definition of "pinned" in the codebase.

**Slice regressions are reported, not filtered.** A candidate that lifts the aggregate while dropping
one slice may still be the right change; that is a judgment for a person with the numbers in front of
them. Hard constraints differ in kind, which is why they are the only thing that rejects.

### 2.3 The search: a deterministic bounded sweep

- **Grid.** The eleven entries of `PriorityPolicy.weights`, one axis at a time, at multipliers
  `0.5 / 0.75 / 1.25 / 1.5`, rounded to integers. **44 candidates**, plus the baseline: 45 policies
  evaluated per run. Coordinate-wise rather than combinatorial — the full cross product is 4^11, and
  a search that large would be fitting noise on any corpus small enough for humans to have judged.
- **Not swept:** `reasonBase` and the two caps. Bands sit 2000 points apart against a band cap of 999
  precisely so a band can never overtake the one above it; ordering *between* bands is structural,
  not tuned. Sweeping those numbers would be redesigning the ranking inside a search, invisibly.
- **`SWEEP_AXES` is an explicit sorted literal**, not `Object.keys(policy.weights)`. Deriving it
  would make the visit order — and therefore the tie-breaks, and therefore the result — depend on the
  order fields happen to be declared in a policy literal.
- **The seed permutes the visit order** via a seeded Fisher-Yates over the canonical grid, and
  nothing else. It matters because candidates tie: when two weight moves reproduce the judged
  orderings equally well, something has to choose, and "first visited" is the only tie-break that
  does not secretly encode a preference about which weight ought to move. That is what makes
  `searchSeed` load-bearing in the manifest rather than decoration.
- **Not a stochastic optimiser.** Every candidate on the grid is evaluated on every run, nothing is
  sampled away, and no branch reads a clock or an unseeded random stream.

### 2.4 Reproducible from the manifest

`CalibrationManifest` carries the corpus digest, the corpus provenance, the base policy version, the
search seed, the number of candidates evaluated, and whether the locked split was consumed.

`runCalibrationFromManifest(manifest, { corpus, basePolicy })` verifies each of those and **throws**
`CalibrationManifestMismatchError` rather than running when one disagrees — a replay that quietly ran
against different inputs and produced a different answer would look exactly like a reproducibility
bug in the code. The grid itself lives in code, not in the manifest, so `candidatesEvaluated` is
re-checked after the run: that is what notices when the search space moved underneath a stored
manifest.

Reproducibility is **tested by round trip**, not asserted: run, serialise, parse the manifest back
out of the text, re-run from it, compare bytes (`serializeCalibrationReport` is canonical JSON).

The digest is order-insensitive (pairs and judgments are sorted first), because reordering rows in a
file is not a change to the corpus. It **includes provenance**, so a corpus relabelled from synthetic
to human is a different corpus and an old manifest will refuse to replay against it.

### 2.5 The single-use locked-split gate

| Outcome | When | Consumes the split? |
|---|---|---|
| `refused_already_used` | The split id is in the used ledger | No |
| `refused_empty_corpus` | Zero judgments, **or** rows but no scorable pair | No |
| `passed` | `rate >= minimumConcordance` | **Yes** |
| `failed` | `rate < minimumConcordance` | **Yes** |

- **An empty corpus is refused, never passed.** A "passed" over zero judgments occupies the same
  field a real pass occupies and certifies nothing, converting an absence of evidence into displayed
  confidence. This is the branch the gate is actually in today.
- **Re-use is checked first**, before anything is measured, so a second run cannot present itself as
  an empty corpus and slip past.
- **A failing gate consumes the split exactly as a passing one does.** If failure were free, the
  cheapest response to a red gate would be a small tweak and another run — optimisation against the
  test set, one attempt at a time.
- **A refusal consumes nothing**, because nothing was measured.

The ledger is a value in and a value out: no file, no module-level mutable set, no clock. The CLI
takes spent split ids as repeatable `--used-split=<id>` flags and prints the ledger to record. No new
persistent state was invented for it.

### 2.6 No clock under `lib/priority/**`

Every entry point takes `generatedAt` / `now` as a parameter; the CLI owns the clock. Feature vectors
are extracted at the corpus boundary at a declared instant, so a calibration run has no
clock-dependent step at all — which is what makes byte-identical replay possible.
`tests/priority/priorityFeatureBoundaries.test.ts` enforces this repo-wide and covers these modules
automatically.

---

## 3. Running it

```sh
# Full run: report + locked gate. Writes docs/quality/reports/priority-calibration.{json,md}
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts

# A different search seed (recorded in the manifest either way)
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts --seed=12345

# Replay a stored report from its manifest; must reproduce it byte for byte
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts \
  --replay=docs/quality/reports/priority-calibration.json

# Declare locked splits already spent
node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts \
  --used-split=priority-seed-split-v1
```

Exit code is non-zero only when the judgment corpus fails to load or the gate **fails**. A refusal is
not a build failure: it is the expected state while the corpus is empty.

---

## 4. When real judgments arrive

No code change is needed to run the pipeline on them. The sequence is:

1. Collect judgments through the #21 annotation queue; they land in
   `data/quality/priority-judgments.json` with `provenance: 'human_reviewed'`
   (`provenanceOf` derives this from the rows — an empty corpus can never be labelled human).
2. Run the CLI. `Status` moves off `CORPUS EMPTY`, a baseline rate appears with its coverage, and the
   sweep reports admissible candidates.
3. Read the **slice** table and the regression list before the headline. An aggregate gain that costs
   a language slice is a multilingual regression, and that is what the seed set's balance exists to
   surface.
4. Run the locked gate **once**, at the end, on the held-out split — and record the split id as spent.
5. If a candidate is to be shipped, a human edits `lib/priority/priorityPolicy.ts` and
   `tests/priority/policyFreeze.test.ts` in the same reviewed commit, citing the report's corpus
   digest and search seed. The pipeline never does this.

---

## 5. Migration and rollback

### 5.1 Migration

**There is nothing to migrate.** This work adds modules, a CLI and tests. It changes no existing
module, no stored schema, no data file, and no runtime path:

- `DEFAULT_PRIORITY_POLICY` is byte-identical to Sprint 04's.
- No production code imports `lib/priority/calibration/**`. The only entry point is the CLI, which
  writes two files under `docs/quality/reports/`.
- No database, no runtime memory record, and no user-visible surface is touched.
- `data/quality/priority-judgments.json` is unchanged and still holds zero rows.

The only new artefacts are `docs/quality/reports/priority-calibration.{json,md}`, regenerated by the
CLI. They are reports; nothing reads them back except `--replay`.

### 5.2 Rollback

Deleting `lib/priority/calibration/**`, `scripts/priority-calibrate.ts`, the four
`tests/priority/calibration*.test.ts` files, `tests/priority/calibrationFixtures.ts` and the two
generated reports removes this work completely. Nothing else depends on any of it, so the revert is a
clean `git revert` with no data step, no backfill and no compatibility window.

There is no rollback path to reason about for the *ranking*, because the ranking never changed. That
is the whole design: a calibration result is a report, so undoing one means deleting a document.

### 5.3 What to do if a future calibration *did* ship weights

Then the rollback is a policy rollback, not a calibration rollback, and it is governed by
`priorityPolicy.ts` and its freeze test rather than by anything here:

1. Revert the commit that edited `DEFAULT_PRIORITY_POLICY` and `policyFreeze.test.ts` together.
2. `PriorityScore.policyVersion` travels on every stored score, so scores produced under the reverted
   weights remain identifiable after the revert. They are not rewritten; they are labelled.
3. Re-run `scripts/priority-calibrate.ts --replay=<the report that justified the change>` to confirm
   the report still reproduces, which distinguishes "the weights were wrong" from "the pipeline
   drifted".

---

## 6. Tests

| File | Covers |
|---|---|
| `tests/priority/calibrationConcordance.test.ts` | the objective, the `unresolved` exclusion, coverage, the digest |
| `tests/priority/calibrationSweep.test.ts` | the grid, determinism, the manifest, the round trip |
| `tests/priority/calibrationConstraints.test.ts` | the admissibility filter, both constraint kinds |
| `tests/priority/calibrationGate.test.ts` | refusals, single use, consumption on failure |
| `tests/priority/calibrationFixtures.ts` | shared builders (not a test file) |

### 6.1 Mutation testing

Each mutation below was applied to the real source, the suite was run, and the source reverted. All
fifteen were caught.

| # | Mutation | Result |
|---|---|---|
| 1 | Constraint check becomes a penalty (`-0.1` per violation) instead of a filter | caught (2 tests) |
| 2a | Manifest omits `searchSeed` | caught (2) |
| 2b | Manifest records a constant seed instead of the one used | caught (2) |
| 3 | `SWEEP_AXES` derived from `Object.keys(policy.weights)` | caught (2) |
| 4 | Gate passes an empty corpus | caught (3) |
| 5 | `unresolved` counted as concordant | caught (3) |
| 6 | `rate` falls back to `0` instead of `null` | caught (6) |
| 7 | A refusal consumes the locked split | caught (1) |
| 8 | Already-used checked *after* emptiness | caught (1) |
| 9 | Corpus digest ignores provenance | caught (1) |
| 10 | Candidate dedupe applied after the seeded shuffle | caught (16) |
| 11 | Conflicting verdicts resolved by taking the first | caught (1) |
| 12 | Replay does not verify the corpus digest | caught (1) |
| 13 | Shuffle uses `Math.random` instead of the seed | caught (2) |
| 14 | Tie detection dropped; the ranker's first element read as a preference | caught (1) |
| 15 | Sweep mutates the base policy's weights in place | caught (21) |

Mutation 3 was initially caught by a single assertion, so
`sweep: the canonical grid order is pinned` was added: it fixes the first eight and the last
candidate by name, so a reordering of the loops themselves — not only of the axis list — is red.
