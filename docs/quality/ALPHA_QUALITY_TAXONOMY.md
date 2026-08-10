# Alpha Quality Failure Taxonomy

> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**
> This taxonomy classifies failures found by the synthetic alpha quality harness.
> It is measurement infrastructure for pre-pilot hardening, not V03 human evidence.

Scope: the deterministic capture → extraction → confirmation → recommendation pipeline
(`src/extraction/*`, `lib/services/nextStepBaseline.ts`, `lib/experiments/*`). Every
failure below is reproducible from a scenario in
`tests/quality/scenarios/alphaQualityScenarios.ts` and re-measurable with
`npm run quality:alpha`.

## Severity levels

| Level | Meaning | Gate impact |
|---|---|---|
| P0 | Blocks or corrupts the core flow; wrong time/date; invented facts; privacy- or trust-violating behavior | Blocks PRE-PILOT READY |
| P1 | Degrades a normal user path; confusing or non-actionable output; fallback misuse | Must be documented; fix before external exposure |
| P2 | Polish / edge cases | Track only |

## Taxonomy categories

| Taxonomy | Severity | Definition | Detection in harness |
|---|---|---|---|
| `invented_fact` | P0 | Extraction or recommendation contains a person, term, or fact not present in user input | `titleMustNotContain` / seeded-token classifier |
| `missed_commitment` | P0 | A genuine commitment in the input is not extracted as a task/follow-up (or is mis-typed) | `expectedType` / `expectedDisposition` |
| `wrong_time` | P0 | Extracted `remindAt`/`dueAt` differs from the user's stated time/date (incl. timezone mishandling) | `expectedDayOffset`, `expectedHourUtc`, `expectedHourOffset` |
| `inappropriate_assumption` | P0 | Pipeline assumes gender, medical context, relationship, or sensitivity not stated | `titleMustNotContain` on sensitive/gendered terms |
| `unfaithful` | P0 | Recommendation contradicts an explicit user instruction (e.g., proposes reminding after "do not remind me") | `expectedDisposition: store_note` + `expectedRecState: empty` |
| `unspecific_next_step` | P1 | Recommended next step is vague or missing the referenced person/action | `recTitleContains` |
| `not_actionable` | P1 | Recommended actions omit the core action set (accept/edit/defer/dismiss/done) | `recActionsInclude` |
| `over_broad` | P1 | A recommendation is offered when the input is informational/empty | `expectedRecState: empty` |
| `multilingual_regression` | P0 | Arabic/Hebrew/mixed-language input handled inconsistently with equivalent English | per-language scenario expectations |
| `fallback_misuse` | P1 | Fallback path produces a task/clarification where a non-commitment was stated | `expectedType: informational_context` on chit-chat/state inputs |

## Failure lifecycle

1. Harness runs each scenario against the real pipeline (`extract()` +
   `decideExtractionDisposition()` + `selectBaselineNextStep()`).
2. Each failing constraint is classified with exactly one taxonomy label.
3. `npm run quality:alpha` writes `docs/quality/reports/alpha-quality-latest.md`
   and fails the gate on any P0.
4. Fixes are implemented in the product pipeline with RED-GREEN regression
   tests; the harness must be re-run and reach GATE PASSED before the fix is
   accepted.
5. Synthetic scenario results are **never** represented as V03 human evidence.

## Current status

See `docs/quality/reports/alpha-quality-latest.md` (regenerated on every run).
