# Sprint 05 — Priority Calibration: Design

Date: 2026-08-19
Issues: [#21](https://github.com/anasakkari3/maybesitter/issues/21), [#22](https://github.com/anasakkari3/maybesitter/issues/22), [#23](https://github.com/anasakkari3/maybesitter/issues/23)

## Context

Sprint 05 builds the apparatus for tuning the Priority policy: a queue to collect ranking judgments,
a calibration pipeline to fit weights against them, and a shadow comparison to see what a weight
change would do before it changes anything.

Two of the three issues were written before Sprint 04 existed, and Sprint 04 invalidated part of what
they assume. Both premises are corrected here rather than implemented as written.

### What Sprint 04 changed

- **`lib/utils/agendaScoring.ts` now delegates to `lib/priority/**`.** There is one ranking
  implementation. A 260,000-case differential fuzz confirmed the delegated path reproduces the
  original arithmetic exactly.
- **`DEFAULT_PRIORITY_POLICY`** (`priority-policy-v1`) holds the weights, versioned, as data.
- **The judgment corpus ships empty** (`data/quality/priority-judgments.json`, zero rows), because
  Sprint 05 calibrating on fabricated preferences was the specific harm to avoid.
- `rankPriorities` has no non-test caller: `agendaScoring` returns `.total` only.

### Corrected premises

1. **#23 asks to "compare current ordering and Priority v1".** Those are now the same code, so as
   written the comparison would compare a thing to itself and report zero disagreement forever — a
   dashboard that looks reassuring while measuring nothing. **Reframed: candidate policy versus
   frozen policy.** Same scorer, different weights. That is a real comparison and it is what #22's
   "no hard constraint regresses" actually needs.
2. **#22 asks to calibrate against reviewed judgments**, which do not exist. **Reframed: the
   machinery is built and exercised, the production weights do not move.** Detail below.

## Architecture

| Component | Path | Owner |
|---|---|---|
| Shared contract | `src/contracts/v1/calibrationContracts.ts` | written first |
| Annotation queue | `lib/priority/annotation/**` | #21 |
| Calibration + manifest | `lib/priority/calibration/**`, `scripts/priority-calibrate.ts` | #22 |
| Shadow comparison | `lib/priority/shadow/**` | #23 |
| **Policy-freeze test** | `tests/priority/policyFreeze.test.ts` | **merge-time, centrally** |

## Component 1 — Annotation queue (#21)

Per the scope split already on the issue:

**Buildable now** — versioned queue schema and storage, a rationale and hard-constraint-flag data
model, and batch load/export tooling.

**Stub** — the judgments themselves. The queue ships empty, exactly as the Sprint 04 corpus does.

| Criterion | Mechanism |
|---|---|
| Duplicate and leakage checks pass | Ingest rejects a second decision for the same (pair, reviewer), and rejects any pair whose members appear in the locked evaluation split — leakage there would let a tuned policy be validated on data it was fitted to. |
| Every decision has reviewer provenance | `reviewerId` and `decidedAt` are non-optional; a decision missing either cannot be constructed. |
| Disagreements are retained, not silently collapsed | Two reviewers disagreeing produces two stored decisions and a flagged conflict, never an averaged or last-write-wins single row. Sprint 04 applied the same rule to `unresolved`: a real conflict that is quietly resolved is information destroyed, and destroyed at exactly the point where it mattered most. |

## Component 2 — Calibration (#22)

### What "calibrate with no judgments" means

The distinction that keeps this honest:

- **The machinery is real and exercised.** A search over the policy weight space, before/after slice
  metrics, failure analysis for regressions, and a manifest that reproduces a run exactly (corpus
  digest, policy version, search seed, tie-break rule).
- **It runs only on judgments explicitly labelled synthetic**, as a proof that the pipeline works.
- **`DEFAULT_PRIORITY_POLICY` does not change.** Production weights remain Sprint 04's until real
  annotations exist.

That last point is the entire safeguard. A calibration run that quietly shipped weights fitted to
invented preferences would be the precise harm Sprint 04's empty corpus was protecting against — and
it would be invisible, because the resulting weights would look like any other tuned numbers. So the
output of a synthetic run is a **report**, never a config swap.

Enforced by `tests/priority/policyFreeze.test.ts`, which pins `DEFAULT_PRIORITY_POLICY` value by
value and fails the moment shipped weights move. Any deliberate future change must edit that test,
making the change visible in review rather than arriving as a diff in a data file.

### Objective and search

**The objective is pairwise concordance with the judgments** — the fraction of judged pairs whose
ranking the candidate policy reproduces — computed only over pairs that are scorable, with
`unresolved` judgments excluded exactly as Sprint 04's agreement report excludes them. Coverage
travels with the figure for the same reason it does there: concordance over three of forty pairs is
a different claim from concordance over forty.

**Hard-constraint preservation is a filter, not a term.** A candidate that reorders a pinned
commitment below an unpinned one is rejected outright rather than penalised, so no amount of
aggregate improvement can buy a constraint violation.

**The search is a deterministic bounded sweep** over the weight space, seeded and reproducible, not
a stochastic optimiser. The point of this sprint is a pipeline whose runs can be replayed from a
manifest; an optimiser whose result depends on wall-clock or unseeded randomness could not satisfy
"configuration is reproducible from manifest".

| Criterion | Mechanism |
|---|---|
| Locked test is used once for final gate | A gate that **refuses to run on an empty corpus** rather than reporting a vacuous pass, and that records its single use in the manifest so a second run against the same locked split is detectable. |
| No hard constraint regresses | The hard-constraint tier (user-pinned high importance) is checked before and after; a candidate that reorders a pinned commitment below an unpinned one fails regardless of its aggregate metrics. |
| Configuration is reproducible from manifest | The manifest carries the corpus digest, policy version, search seed and tie-break rule; re-running from a manifest must produce byte-identical output. Tested by round-trip, not asserted. |

### Non-goal, stated plainly

Fitting weights to the synthetic corpus and shipping them. The synthetic corpus exists to prove the
pipeline runs, not to say anything about what a person would prefer.

## Component 3 — Shadow comparison (#23)

Compares a **candidate policy** against the **frozen policy** over a set of commitments, reporting
where the resulting order differs and why.

| Criterion | Mechanism |
|---|---|
| Shadow output cannot affect persistence or UI | The module imports no writer and no UI surface, enforced by a boundary test walking the transitive import closure — the technique that caught a real side-effect-import gap in Sprint 03. Shadow comparison returns a value; it has no write path to return through. |
| Sampling is configurable | An explicit sample rate and a deterministic, seeded selection, so a sampled run is reproducible rather than merely cheap. |
| Metrics separate missing context from scorer disagreement | Two distinct causes, reported separately. A rank change caused by an unknown feature is a **data** problem; a rank change caused by different weights over identical known features is a **policy** problem. Conflating them sends a reader to debug the wrong thing — and given `dependency` and `effort` are permanently unknown, the first category is guaranteed non-empty. |

## Testing

Repo conventions: `node:test` + `node:assert/strict`, flat `test(...)`, `.ts` extensions in test
imports. **New test files are registered in `package.json` centrally at merge**, not by the parallel
agents.

Not delegated:

1. **The policy-freeze test**, because it is the safeguard against the failure this sprint exists to
   avoid, and it must not be owned by the track whose output it constrains.
2. **A cross-track test** running #21's queue through #22's calibration into #23's comparison.
   Sprints 02, 03 and 04 each showed per-track suites passing while tracks disagreed; in Sprint 04
   the integration was also what proved the delegation safe.

Determinism is required of the calibration search and the shadow sampler: explicit seeds, explicit
`now`, no system clock under `lib/priority/**` (a Sprint 04 test already enforces this repo-wide and
will police these new modules automatically).

## Execution plan

1. Write and commit `src/contracts/v1/calibrationContracts.ts`.
2. Three parallel agents in isolated worktrees on disjoint directories.
3. Merge; centrally add the policy-freeze test, `package.json` registration, and the
   `moduleContracts.ts` entry if warranted.
4. Cross-track test.
5. `/code-review` in the foreground — background runs were interrupted twice in Sprint 03 and a
   branch shipped unreviewed; the foreground run in Sprint 04 found four real defects.
6. Full verification, then PR.

## Non-goals

- Changing `DEFAULT_PRIORITY_POLICY`.
- Collecting real annotations, or generating rows that could be mistaken for them.
- Wiring `rankPriorities` into a live ordering path.
- Migrating the Sprint 03 `behaviorFeedbackService` dual-write and its two readers.
- Any UI surface for calibration or shadow results.
- Direct model writes to canonical user state.

## Risks

- **A synthetic calibration run is mistaken for a real one.** Mitigation: the corpus is labelled
  synthetic at the type level, the report states it, the locked gate refuses an empty corpus, and the
  policy-freeze test fails if shipped weights move.
- **The shadow comparison reports zero disagreement and looks broken.** With the frozen policy as
  both sides it *should* report zero; the tests therefore compare a deliberately perturbed candidate
  so a zero result is a real signal rather than the only result the code can produce.
- **Leakage between the annotation corpus and the locked split.** Mitigation: the ingest check in
  #21, tested from both directions.
