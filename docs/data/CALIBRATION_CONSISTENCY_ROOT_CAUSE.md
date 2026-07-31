# Root cause: the failed blind-review consistency gate

The pilot-v4 staged compiler has been reporting
`blockedReason: "calibration_consistency_not_completed"` and refusing to release
training data. This is why, what was actually wrong, and what changed.

Sprint 01 · issue [#5](https://github.com/anasakkari3/maybesitter/issues/5).

## What the original instrument reported

`scripts/gemma-calibration/consistency_review.py report`, run against the
committed calibration data:

```json
{
  "kind": "intra-reviewer consistency",
  "completedSecondPass": 10,
  "decisionAgreement":        { "matches": 7,   "compared": 10,  "rate": 0.7 },
  "fieldLevelAgreement":      { "matches": 137, "compared": 140, "rate": 0.978 },
  "commitmentCountAgreement": { "matches": 0,   "compared": 0,   "rate": null },
  "boundaryAgreement":        { "matches": 0,   "compared": 0,   "rate": null },
  "dateTimeAgreement":        { "matches": 30,  "compared": 30,  "rate": 1.0 }
}
```

Read that carefully. Decision agreement is 70%. And the two dimensions the
multi-commitment gate exists to measure — commitment count and boundary — were
compared **zero** times and reported `null`.

## Root causes

### CAL-001 — the instrument could not see what it claimed to measure

`consistency_review.py` computes boundary and count agreement from
`completion.segments` and `completion.commitmentCount`:

```python
if "commitmentCount" in a or "commitmentCount" in b: ...
if "segments" in a or "segments" in b: ...
```

Neither key exists. Across all 60 decision records in the two passes, the
`completion` payload carries exactly fourteen fields:

```text
action, ambiguityFlags, confidence, dueAt, explicitPressureRequest,
explicitReminderRequest, flexibility, localTimeSpec, missingFields, person,
priority, remindAt, title, type
```

The review completion is a *single overall* ExtractionResult. Per-item
boundaries live in a different file, `data/review/per-item-gold.jsonl`, which
the consistency script never opens.

So both conditions were always false, both dimensions reported `compared: 0`,
and the metric came back `null` rather than raising. **The multi-commitment gate
failed open.** It never passed and it never failed; it was never evaluated.

### CAL-004 — a guideline changed mid-round and nothing recorded it

Two of the three decision disagreements are the same thing:

| Source | Pass 1 | Pass 2 | Pass 2 reason |
| --- | --- | --- | --- |
| `pilot-v4-review-hebrew-039` | accepted | rejected | "Multiple commitments are combined instead of separated and ordered." |
| `pilot-v4-review-ambiguous-029` | accepted | rejected | "Multiple commitments are combined instead of separated and ordered." |

Both sources genuinely contain two commitments:

```text
תתקשר למאיה ותשלח את דוח פרויקט V4-NORMAL-039 מחר.
Call Maya and send the project V4-0454 report tomorrow. / تذكير مختصر / תזכורת V4-0454
```

The timeline settles it:

```text
first pass    2026-07-28T23:56:11Z → 2026-07-29T00:43:12Z
                    ← per-item Gold separation workflow introduced here →
second pass   2026-07-29T02:15:53Z → 2026-07-29T02:17:47Z
```

The first pass was made under a rule set where a multi-commitment source was
judged on its primary commitment, because there was no way to record the
secondary one. Between the passes, the remediation round introduced explicit
per-item separation. The blind second pass applied the new rule.

These two items are also *exactly* the two blind-set sources that have per-item
Gold. The reviewer was not being inconsistent — they were correctly applying the
newer guideline to the sources they had just annotated under it.

The instrument had no concept of a policy version, so it scored a rule change as
reviewer unreliability and dragged agreement from 87.5% to 70%.

### CAL-002 — the annotation tooling invented a timestamp

`pilot-v4-review-hebrew-039` was annotated per-item twice under the same policy.
The two annotations agree on commitment count, on both segment boundaries, and
on every non-temporal slot. They differ on exactly one field:

```text
annotation 1   items[1].target.dueAt = "2026-07-30T03:38:00-04:00"
annotation 2   items[1].target.dueAt = null
```

The source's own reference time is `2026-02-06T17:00:00-05:00` in
`America/New_York`, so `מחר` (tomorrow) resolves to **2026-02-07**.
`2026-07-30T03:38` is the annotation session's own wall clock — the review ran
on 2026-07-29/30. The datetime control defaulted to *now* instead of resolving
against the record's `reference_time`.

The correction is right to reject it, but it sets `dueAt` to `null`, which
discards the date the source actually stated. Per-item schema 1.0.0 requires a
clock `time` inside `localTimeSpec`, so there is no way to record a date-only
"tomorrow". The reviewer was forced to choose between an invented time and a
lost date.

**Neither annotation is usable Gold.** This source needs re-annotation.

### CAL-003 — the blind sample under-sampled the dimension under test

`pilot-v4-review-ambiguous-029` contains two commitments but is categorised
`difficult_code_switching`, not `multiple_commitments`. Stratified selection
draws on `primaryCalibrationCategory`, so the blind ten contained **one**
multi-commitment item where the corpus had eight.

The gate meant to certify multi-commitment annotation drew a single sample of it.

### CAL-005 — the accept-vs-edit threshold was undefined

The remaining disagreement, `pilot-v4-review-arabic-003`
(`احذف مهمة أغراض المشروع V4-NORMAL-003.`), is genuine reviewer noise:

| | decision | title |
| --- | --- | --- |
| Pass 1 | edited | `Shopping task for project V4-NORMAL-003` |
| Pass 2 | accepted | `Project V4-NORMAL-003 task` |

Both passes agree on type (`follow_up`), action (`delete`), and all temporal
fields. Policy 1.0.0 never said when a title rewrite requires `edited` rather
than `accepted`, so the same reviewer answered differently twice.

Pass 1 is canonical: its title preserves `أغراض` (supplies), which pass 2 drops.

## Summary

Of the three decision disagreements, **one** measured reviewer reliability. The
other two measured an unrecorded guideline change. And the dimension the gate
existed for was never measured at all.

| Defect | Class | Effect |
| --- | --- | --- |
| CAL-001 | instrument | boundary and count agreement structurally unmeasurable; gate failed open |
| CAL-004 | process | mid-round guideline change unrecorded; scored as reviewer noise |
| CAL-002 | tooling | datetime control defaulted to session clock; schema cannot express date-only |
| CAL-003 | taxonomy | multi-commitment source mis-categorised; blind set drew 1 instead of 2 |
| CAL-005 | guidance | accept-vs-edit threshold for title paraphrase undefined |

## What changed

**Policies are versioned.** `data/calibration/annotation-policy.json` records
1.0.0 (overall completion), 2.0.0 (per-item separation, the mid-round change),
and 2.1.0 (this issue's corrective guidance). Each version names the rules it
changed and which review dimensions those rules can move.

**Disagreements are adjudicated, additively.**
`data/calibration/adjudications.jsonl` records, per source *and dimension*,
which pass is canonical, under which policy, and why. It never touches
`data/review/gold-decisions.jsonl`. Both original human decisions survive
verbatim and stay traceable.

Adjudications are scoped to a dimension because `hebrew-039` needed two: its
decision flipped because of a guideline change, while its per-item date-time
differed because of a tooling defect. One verdict per source could not express
that without blaming the wrong cause.

A `policy_shift` claim is checked, not trusted: the two passes must have been
made under different policy versions, and some rule change between them must
declare that it affects the dimension being claimed. You cannot label an
inconvenient disagreement a policy shift without a policy change that supports it.

**The instrument measures what it claims.** `lib/calibration/perItemAgreement.ts`
reads boundaries from the per-item file and compares repeat annotations of the
same source by the same reviewer. An unmeasurable dimension is now a **gate
failure**, never a `null`.

**Rates carry intervals.** Every rate reports a 95% Wilson interval and an
`underpowered` flag. At n=10 a single item moves a rate by ten points; the
original gate reported a bare number with no power statement.

**Policy shifts leave the denominator; noise stays in it.** A disagreement
adjudicated as `policy_shift` or `tooling_defect` is *excluded* from the
reliability metric, not counted as agreement. Counting it as agreement would
inflate the rate; leaving it in blames the reviewer for a guideline change.

## The gate now

```text
compared items: 10
classification: agreement 7, policy_shift 2, tooling_defect 0, reviewer_noise 1

  raw decision              0.7000 (7/10)  [95% CI 0.397–0.892]  underpowered
  policy-normalized         0.8750 (7/8)   [95% CI 0.529–0.978]  underpowered
  commitment_count          1.0000 (1/1)   [95% CI 0.207–1.000]  underpowered
  boundary                  1.0000 (1/1)   [95% CI 0.207–1.000]  underpowered
  slots                     1.0000 (10/10) [95% CI 0.722–1.000]  underpowered
  date_time                 1.0000 (5/5)   [95% CI 0.566–1.000]  underpowered

gate: pass_provisional
```

All five dimensions are measurable, where two were not. Policy-normalized
decision agreement is 0.875 against a 0.85 threshold. Every disagreement is
adjudicated.

**It is provisional, and that word is load-bearing.** Eight comparable items is
far below the 30 the thresholds require for a final result, and the 95% interval
on 7/8 runs down to 0.529. The point estimate clears the bar; the interval does
not. One source still needs re-annotation.

A provisional pass authorizes the Gold freeze. It does not authorize training —
`gateAuthorizesTraining` returns true only for a full `pass`. Issue #5 forbids
training regardless, but the distinction is enforced in code so it survives the
issue.

## What is still open

1. **Extend the blind set.** Thirty comparable items is the threshold for a
   non-provisional pass; there are eight. This needs a human doing blind
   re-review and cannot be closed mechanically.
2. **Re-annotate `pilot-v4-review-hebrew-039`** once per-item schema 1.1.0 can
   express a date-only `localTimeSpec`. It is excluded from the freeze until then.
3. **Fix the annotation datetime control** to resolve against the record's
   `reference_time` (policy rule TIME-001) rather than the session clock.
4. **Re-categorise multi-commitment sources** under rule CAT-001 and re-draw the
   blind sample so the stratum is represented in proportion to the corpus.
5. **Second reviewer.** Everything here is *intra*-reviewer: one person compared
   with themselves. That measures self-consistency, not whether the guidelines
   mean the same thing to two people. Inter-reviewer agreement is unmeasured.
