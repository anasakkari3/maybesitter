# Priority Annotation Queue

Sprint 05, [issue #21](https://github.com/anasakkari3/maybesitter/issues/21).
Design: `docs/superpowers/specs/2026-08-19-sprint-05-priority-calibration-design.md`, Component 1.
Rubric the decisions follow: `docs/quality/PRIORITY_ANNOTATION_RUBRIC.md`.

## 0. Status — the queue ships empty, and that is the deliverable

**`data/quality/priority-annotation-decisions.json` contains zero decisions.**

The issue title says "run an annotation round". The scope split committed on the issue says
otherwise, and the split wins: the queue, schema, storage, ingest checks, conflict detection,
coverage report and export tooling are buildable now; **the judgments themselves are a stub**.

This is the same call Sprint 04 made for `data/quality/priority-judgments.json`, for the same
reason. Issue #22 fits the Priority policy's weights against exactly this corpus. Weights fitted to
preferences nobody expressed look identical to weights fitted to real ones — there is no later
inspection that can tell them apart — so plausible-looking reviewer decisions here would not be
untidy, they would feed invented human preferences into the tuning of what a user sees.

`tests/priority/annotationCoverage.test.ts` asserts the store is empty with **both exits closed**:

- valid rows would pass a validity check, so the **row count** is asserted separately, and against
  the raw file rather than the loader's output;
- invalid rows would make the count zero for the wrong reason, so **validity** is asserted too.

That test is designed to fail the moment rows appear, so the first real decisions arrive in a commit
that names who reviewed, when, and under which rubric version. §5 is how to do that.

## 1. What is here

| Module | Purpose |
|---|---|
| `lib/priority/annotation/annotationQueue.ts` | Builds the queue from the seed pairs, tracks `QueueItemState`, cuts and parses reviewer batches. |
| `lib/priority/annotation/reviewedDecision.ts` | The only constructor for a decision, plus its validator. Enforces reviewer provenance. |
| `lib/priority/annotation/decisionStore.ts` | Append-only storage over a repository seam; file and in-memory backends; conflict detection. |
| `lib/priority/annotation/decisionIngest.ts` | The four rejection checks, conflict reporting, and batch-orientation verification. |
| `lib/priority/annotation/decisionCorpus.ts` | Reads and validates the committed corpus. The ingestion point. |
| `lib/priority/annotation/queueCoverage.ts` | `QueueCoverageReport` and its markdown rendering. |
| `scripts/priority-annotation-queue-run.ts` | CLI. Owns the clock; every builder it calls takes `generatedAt`. |

Contracts are `src/contracts/v1/calibrationContracts.ts`, committed before this work started and not
modified by it.

## 2. The queue

`buildAnnotationQueue({ enqueuedAt })` turns `PRIORITY_SEED_PAIRS` into `AnnotationQueueItem`s. It
**withholds every pair in the locked evaluation split** and returns their ids in
`withheldLockedPairIds` rather than filtering silently — a caller who expected 20 items and got 16
needs to see why, and a silent filter is indistinguishable from a bug that lost four pairs.

`slice` defaults to `` `${language}/${loadPattern}` ``. Language is the axis on which a verdict
change is a defect by definition (matched cells differ only in ids and text); load pattern is the
axis on which the *cost* of a ranking error changes. Pass `sliceOf` for coarser buckets.

Item and decision ids match strict patterns (`/^aq_[A-Za-z0-9_-]{1,120}$/`,
`/^dec_[A-Za-z0-9_-]{1,120}$/`). Decision ids reach the filesystem as `<id>.decision.json` and are
**caller-supplied**, so the pattern is the only thing between an imported file and a path traversal.
Ids are refused rather than sanitised: a sanitised id could collide with another pair's, silently
merging two records into one.

### Batches

`exportAnnotationBatch(items, { batchId, exportedAt, limit, offset })` cuts a batch for one reviewing
session. Batches are ordered by item id and sliced by offset/limit, so successive batches partition
the queue rather than overlapping — a reviewer shown the same pair twice would produce a duplicate
that ingest then rejects, which wastes their time. `parseAnnotationBatch` is all-or-nothing: a batch
with one malformed item returns `null`, because a file that lost a row in transit should be fixed and
re-imported rather than silently shortened.

## 3. Storage

One implementation of the semantics over a `DecisionRepository` seam; the file and in-memory backends
differ only in persistence. This follows `lib/runtimeMemory/runtimeMemoryStore.ts`, and for the
reason recorded there: the sibling alpha stores duplicated their logic per backend and their
in-memory `prune()` drifted into a no-op. A test store that behaves differently from a production
store proves nothing about production.

- **Append-only.** A decision is never overwritten. A second write under one id throws, and so does a
  second decision from one reviewer on one pair under a *different* id — that would be
  last-write-wins wearing two row ids.
- **Temp-then-rename, mode 0600.** A reader never observes a half-written decision, and a rationale
  is a named person's own words.
- **Corrupt files are skipped, not fatal.** One damaged file cannot deny access to the rest of the
  corpus.
- **Deletion reaches further than reading.** `deleteReviewer(id)` sweeps `.tmp` files left by crashed
  writes and files too damaged to parse, because both still hold the reviewer's text; reading skips
  them, deleting must not. A file too damaged to name *any* owner is left in place — destroying
  unattributable files on one reviewer's deletion could destroy another reviewer's work.

File layout: `<MAYBESITTER_DATA_DIR|cwd/.maybesitter>/priority-annotation/<decisionId>.decision.json`.

## 4. Ingest

Every row is either accepted or returned with a code. Nothing is dropped silently.

| Code | When | Why it is fatal to the row |
|---|---|---|
| `MALFORMED_DECISION` | Shape or provenance fails validation. | A decision whose author or time is unknown cannot be audited, and an unauditable judgment is not one a ranking may be fitted to. |
| `LOCKED_SPLIT_LEAKAGE` | The pair is in the held-out evaluation split. | A policy fitted on a pair and then validated on that same pair produces a number that measures nothing. |
| `UNKNOWN_PAIR` | No queue item names the pair. | A verdict about a pair nobody defined refers to nothing. |
| `DUPLICATE_DECISION` | This reviewer already decided this pair. | Two submissions from one person are not two data points; accepting both weights their opinion by however many times they pressed send. |

**Check order is deliberate.** Leakage is tested *before* unknown-pair, because the queue withholds
locked pairs — so a locked pair is also absent from the queue, and reporting `UNKNOWN_PAIR` would
send a maintainer to add it to the queue, the exact opposite of what must happen.

**Leakage is decided against the split, never against the queue.** A queue built before a pair was
locked still lists it; the split is the authority, so a stale queue cannot launder a locked pair.
Both directions are tested: a decision naming a locked pair, and a pair that became locked after the
queue was built.

`QueueIngestResult` fixes what a consumer may rely on. `DecisionIngestOutcome` extends it with
`issues` (the *reasons* — a code alone says a row is malformed but not which field),
`unresolvedCount` and `abstainedPairIds`.

### Conflicts: detected, retained, never resolved

Two reviewers who disagree on a pair produce **two stored rows and one `DecisionConflict`**. There is
no code path that averages them and none that lets a later write win.

This is not fastidiousness about immutability. Disagreement usually means the rubric is ambiguous at
that pair — a fact about the rubric — and a collapsed row destroys it exactly where it carries the
most information. Sprint 04 made the same call for `unresolved` in the agreement report.

A conflict is emitted when one pair carries **two or more distinct reviewers** with **two or more
distinct resolving verdicts**. `decisionIds` and `verdicts` are **parallel arrays** ordered by
decision id: `decisionIds[i]` carries `verdicts[i]`.

`unresolved` is **excluded from conflict detection** and counted separately, following Sprint 04
unchanged: an abstention is neither agreement nor disagreement. Calling it a conflict would penalise
a reviewer for correctly following the rubric's abstention rules and push them to guess, converting
honest abstention into fabricated preference — the exact failure this track exists to prevent. The
abstaining row is still stored and still visible in `abstainedPairIds` and `unresolvedCount`; it
simply does not manufacture a conflict nobody expressed.

What a consumer sees: `QueueIngestResult.conflicts`, `DecisionStore.conflicts()`, and
`QueueCoverageReport.conflictCount`. The committed `DecisionConflict` carries no reviewer field, so a
consumer needing to know *who* disagreed joins back on `decisionId`.

### Orientation

`ReviewedDecision` carries `pairId` and `verdict` but **not** the orientation the reviewer saw. If a
pair's left and right were swapped between export and ingest, a verdict of `left` would silently
refer to a different commitment. Sprint 04's judgment loader guards this (`PRJ022`) because
`PairwiseJudgment` carries both commitment ids; the Sprint 05 contract does not.

The batch file the reviewer worked from *does* carry the orientation, so
`verifyBatchOrientation(batch, queue)` closes the gap at the only place the information still exists.
**Run it before ingesting decisions that came back with a batch.** The locked split additionally has
`verifySeedSetLock()`, which the CLI runs on every invocation.

## 5. How a future maintainer runs a real annotation round

1. Recruit at least two reviewers. Have each read `docs/quality/PRIORITY_ANNOTATION_RUBRIC.md` in
   full. Two is the minimum that makes agreement — and therefore conflict — measurable at all.
2. Cut disjoint batches, one per reviewing session:
   ```
   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-annotation-queue-run.ts \
     --export-batch out/batch-01.json --batch-id batch-01 --batch-limit 8 --batch-offset 0
   ```
   Give **every reviewer the same pairs** — the disjointness is across sessions, not across
   reviewers. Two reviewers on disjoint pairs produce no agreement figure and no conflicts.
3. Collect one `ReviewedDecision` per (pair, reviewer). `reviewerId` and `decidedAt` are mandatory;
   `rationale` is mandatory even for a `tie`, because a verdict with no stated criterion cannot be
   audited against the rubric. Prefer `createReviewedDecision(...)` over hand-writing rows.
4. Verify the batches still describe the current queue with `verifyBatchOrientation`, then ingest
   with `ingestIntoStore(rows, store, { queue })`. **Read the `rejected` array.** Every rejection is
   a row that will not be in the corpus.
5. Export the store with `store.export({ exportedAt, provenance: 'human_reviewed', rubricVersion })`
   and write the result to `data/quality/priority-annotation-decisions.json`.
6. Re-run the CLI. It re-ingests the committed file, so a hand-appended row is held to the same
   standard as one that arrived through the store.
7. **Replace the zero-row assertion in `tests/priority/annotationCoverage.test.ts` in the same commit
   that adds the first real rows.** Replace it rather than delete it: the guard becomes an assertion
   that the corpus matches the round it claims to come from — an expected row count, the expected
   reviewer ids — so the corpus stays pinned to a real event rather than becoming unguarded. Say in
   the commit message who reviewed, when, and under which rubric version.
8. If the rubric's criteria change, bump `RUBRIC_VERSION` and treat existing decisions as belonging
   to the previous version. Decisions are only comparable within one rubric version.

Never set `provenance: 'human_reviewed'` on rows that were generated. A synthetic corpus is legitimate
for proving the pipeline runs and must say so in the data, because a report over it will otherwise be
read as evidence about what a person would prefer.

## 6. Migration and rollback

**Migration in.** There is nothing to migrate. This sprint adds a new corpus file
(`data/quality/priority-annotation-decisions.json`) and a new store directory
(`.maybesitter/priority-annotation/`); no existing file, schema or record changes shape.
`data/quality/priority-judgments.json` and everything under `lib/priority/rubric/**` are untouched,
and the two corpora are independent: Sprint 04's holds `PairwiseJudgment` rows under
`priority-judgments-v1`, this one holds `ReviewedDecision` rows under `priority-calibration-v1`.

**Forward compatibility.** `contractVersion` is checked exactly, not ranged. A corpus written by a
future schema fails to load rather than being half-understood — a loader that guesses at an
unrecognised version is a loader that silently mis-reads the next schema.

**Rollback.** Reverting this work is safe and complete in one step, because nothing here is on a
serving path:

- No module under `lib/priority/annotation/**` is imported by application code, by
  `lib/utils/agendaScoring.ts`, or by any UI surface. `DEFAULT_PRIORITY_POLICY` is untouched and
  frozen this sprint.
- Deleting `lib/priority/annotation/**`, `scripts/priority-annotation-queue-run.ts`,
  `tests/priority/annotation*.test.ts`, `data/quality/priority-annotation-decisions.json` and the two
  `docs/quality/reports/priority-annotation-queue-coverage.*` artifacts returns the repo to its
  Sprint 04 behaviour with no data loss, because the shipped corpus holds zero rows.
- Once real decisions exist, that changes: `data/quality/priority-annotation-decisions.json` becomes
  irreplaceable human evidence and must be preserved across any revert. Reviewer time cannot be
  re-run from a backup of the code.

**Rolling back after a bad ingest.** The store is append-only, so a wrongly-ingested row is removed
with `store.remove(decisionId)` — never by editing a row in place, which would leave the corpus
claiming a reviewer said something they did not. To remove one reviewer's contribution entirely
(withdrawal of consent, or a round found to have been run under the wrong rubric version), use
`store.deleteReviewer(reviewerId)`, which also sweeps their corrupt and half-written files, then
re-export.

## 7. Tests

| File | Covers |
|---|---|
| `tests/priority/annotationQueue.test.ts` | Locked-split withholding, item shape, determinism, state transitions, batch partitioning and parse. |
| `tests/priority/annotationDecisionStore.test.ts` | Both backends from one table: append-only, retained conflicts, forged-input refusal, path-traversal refusal, Arabic/Hebrew round-trip, corrupt-file tolerance, deletion completeness. |
| `tests/priority/annotationIngest.test.ts` | The four rejection codes, leakage from both directions, nothing dropped, conflicts across batch and store, orientation drift. |
| `tests/priority/annotationCoverage.test.ts` | **The shipped corpus is empty, both exits closed**, `corpusEmpty`, slice accounting, determinism. |

Run one file with:

```
node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/priority/annotationQueue.test.ts
```

New test files are registered in `package.json` centrally at merge, not by the implementing agent.
