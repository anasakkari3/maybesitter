# Priority Annotation Queue Coverage

> The commitment pairs queued here are **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**
> (`tests/fixtures/prioritySeedSet.ts`). The *decisions*, when any exist, are human judgments and are
> the only human evidence in this report.

Generated: 2026-08-18T22:03:22.574Z
Schema: `priority-calibration-v1`
Status: **CORPUS EMPTY**

## Queue

Items: 16 | Decided: 0 | Pending: 16 | Skipped: 0

Withheld from the queue: 4 pairs in the **locked evaluation split**. They are never handed to a reviewer, and a decision naming one is rejected at ingest (`LOCKED_SPLIT_LEAKAGE`). A pair that is fitted on and then validated on measures nothing.

- `ps-ar-heavy-01`
- `ps-en-moderate-01`
- `ps-he-overloaded-01`
- `ps-mixed-light-01`

## No reviewer decision has been recorded

The decision store contains **zero decisions**. Sprint 05 ships this ingestion point wired and
empty: the queue, schema, storage, ingest checks and this report are present and tested, and
`data/quality/priority-annotation-decisions.json` carries no rows.

No coverage rate is reported, because there is nothing to report. Issue #22 fits ranking weights
against this corpus; rows written by engineering would read as reviewer evidence while being
nothing of the kind, and the weights fitted to them would be indistinguishable from weights fitted
to real preferences.

A pair on which two reviewers disagree produces **two stored decisions and one conflict** — never an average and never a last-write-wins row. Disagreement usually means the rubric is ambiguous at that pair, which is a fact about the rubric, and a collapsed row would destroy it exactly where it carries the most information. An `unresolved` verdict is counted separately and is *not* a conflict, following Sprint 04's treatment of abstention: it is neither agreement nor disagreement, and calling it a conflict would push a reviewer to guess rather than abstain.

To run a real annotation round, see §5 of `docs/quality/PRIORITY_ANNOTATION_QUEUE.md`.

## Queue composition

| slice | items | decided |
|---|---|---|
| `ar/light` | 1 | 0 |
| `ar/moderate` | 2 | 0 |
| `ar/overloaded` | 1 | 0 |
| `en/heavy` | 1 | 0 |
| `en/light` | 2 | 0 |
| `en/overloaded` | 1 | 0 |
| `he/heavy` | 2 | 0 |
| `he/light` | 1 | 0 |
| `he/moderate` | 1 | 0 |
| `mixed/heavy` | 1 | 0 |
| `mixed/moderate` | 2 | 0 |
| `mixed/overloaded` | 1 | 0 |

---
*End of report.*
