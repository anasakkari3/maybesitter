# Priority Calibration Report

> **SYNTHETIC — PIPELINE PROOF ONLY — NOT HUMAN EVIDENCE.** The judgments behind this run are
> labelled `synthetic_pipeline_proof`. They demonstrate that the calibration pipeline runs. They say
> nothing about what any person would prefer, and no weight in this report may be shipped on their
> authority.

Generated: 2026-08-18T22:09:43.669Z
Status: **CORPUS EMPTY**
Base policy: `priority-policy-v1` | Schema: `priority-calibration-v1`

## Manifest

| field | value |
|---|---|
| corpus digest | `784f8c87550da26676ec9e10b8f2970e79757fb7885468f4010bc25c0a23a514` |
| corpus provenance | `synthetic_pipeline_proof` |
| search seed | 20260819 |
| candidates evaluated | 45 |
| locked split used | no |

Re-running from this manifest, against the same corpus and base policy, reproduces this report
byte for byte.

## Concordance

Baseline: not computable over 0 of 16 pairs (0 concordant)
Best admissible candidate: **none**.

Admissible candidates: 44 of 44. Rejected for a hard-constraint violation despite beating the baseline: 0.

Hard-constraint preservation is a filter, not a scoring term: a candidate that reorders a constrained
pair is rejected outright, whatever it does to the aggregate.

> No pair in this corpus was scorable, so no rate is reported. A rate of 0 here would present the
> absence of judgments as a measurement of total disagreement.

## Slices

| slice | before | after |
|---|---|---|
| `ar/light` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `ar/moderate` | not computable over 0 of 2 pairs (0 concordant) | not computable over 0 of 2 pairs (0 concordant) |
| `ar/overloaded` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `en/heavy` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `en/light` | not computable over 0 of 2 pairs (0 concordant) | not computable over 0 of 2 pairs (0 concordant) |
| `en/overloaded` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `he/heavy` | not computable over 0 of 2 pairs (0 concordant) | not computable over 0 of 2 pairs (0 concordant) |
| `he/light` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `he/moderate` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `mixed/heavy` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |
| `mixed/moderate` | not computable over 0 of 2 pairs (0 concordant) | not computable over 0 of 2 pairs (0 concordant) |
| `mixed/overloaded` | not computable over 0 of 1 pairs (0 concordant) | not computable over 0 of 1 pairs (0 concordant) |

## Regressions

No slice lost concordance under the selected candidate.

### Pairs the candidate gets wrong that the baseline got right

None.

## What this report is not

It is not a configuration change. `policyUnchanged` is `true` and is typed as the literal `true`:
shipping any weight found here is a separate, deliberate edit to `lib/priority/priorityPolicy.ts`,
visible in review, and blocked by `tests/priority/policyFreeze.test.ts` until someone changes that
test on purpose.

---
*End of report.*
