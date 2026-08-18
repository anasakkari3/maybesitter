# `data/quality/`

## `priority-judgments.json`

The human pairwise-judgment corpus for the Priority annotation rubric
(Sprint 04, [issue #19](https://github.com/anasakkari3/maybesitter/issues/19)).

**It contains zero rows, and that is the correct state.**

No annotation has been run. The schema, loader, validation and agreement
arithmetic all exist and are tested (`lib/priority/rubric/agreementReport.ts`),
so the ingestion point is wired; the data is simply not there yet. Rows written
by engineering would read as human evidence while being nothing of the kind, and
Sprint 05 calibrates a ranking policy against exactly this file.

`tests/priority/prioritySeedSet.test.ts` asserts the corpus is empty. That test
is designed to fail the moment rows appear, so the first real annotations arrive
in a commit that names who annotated and when.

To supply real judgments, follow §9.1 of
`docs/quality/PRIORITY_ANNOTATION_RUBRIC.md`.

## `priority-annotation-decisions.json`

The reviewed pairwise-decision corpus for the Priority annotation queue
(Sprint 05, [issue #21](https://github.com/anasakkari3/maybesitter/issues/21)).

**It contains zero rows, and that is the correct state.**

No annotation round has been run. The queue, schema, storage, ingest checks,
conflict detection and coverage report all exist and are tested
(`lib/priority/annotation/**`), so the ingestion point is wired; the data is
simply not there yet. Issue #22 fits the Priority policy's weights against
exactly this file, and weights fitted to preferences nobody expressed look
identical to weights fitted to real ones.

`tests/priority/annotationCoverage.test.ts` asserts the corpus is empty with
both exits closed: valid rows fail the row-count check, invalid rows fail the
validity check. That test is designed to fail the moment rows appear, so the
first real decisions arrive in a commit that names who reviewed and when.

This corpus is independent of `priority-judgments.json`: that one holds
`PairwiseJudgment` rows under `priority-judgments-v1`, this one holds
`ReviewedDecision` rows under `priority-calibration-v1`.

To run a real annotation round, follow §5 of
`docs/quality/PRIORITY_ANNOTATION_QUEUE.md`.
