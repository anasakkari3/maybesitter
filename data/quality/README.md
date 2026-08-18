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
