# Sprint 04 — Priority Engine v1: Design

Date: 2026-08-18
Issues: [#17](https://github.com/anasakkari3/maybesitter/issues/17), [#18](https://github.com/anasakkari3/maybesitter/issues/18), [#19](https://github.com/anasakkari3/maybesitter/issues/19)

## Context

Sprint 04 turns commitment ranking into something that can explain itself: a typed feature vector
traceable to source state, a configurable scoring policy whose explanation reconciles numerically
with its own output, and a rubric plus seed set for evaluating ranking quality.

Like Sprint 03 and unlike Sprint 02, this is **not greenfield**.

### What already exists

- **`lib/utils/agendaScoring.ts` is already a deterministic priority scorer.** It is live, feeding
  `lib/services/agendaService.ts` and Sprint 02's `lib/lifeState/loadView.ts`. Its composition:

  ```
  bandScore = clamp(reasonTime + importance + repeatedDelay + ignored, 0, 999)
  total     = clamp(REASON_BASE_SCORE[reason] + bandScore, 0, 9999)
  ```

  with `REASON_BASE_SCORE` of overdue 7000 / due_soon 5000 / active 3000 / pending 1000. It returns
  a bare `number`: no reason codes, no breakdown.
- **Sprint 03's `aggregateFeedback`** (`lib/feedback/feedbackAggregation.ts`) — pure, deterministic,
  digest-verified behavioural aggregates. Priority is its first real consumer.
- **Sprint 02's `Field<T>`** (`src/contracts/v1/lifeStateContracts.ts`) — the established way to say
  "unknown" without it being mistaken for zero.
- `src/domain/stateMachine.ts` — `Commitment` carries id, kind, title, description, person, status,
  priority, timeSpec, currentAckState, postponedUntil and timestamps. **It has no dependency field
  and no effort/estimate field.**

### Scope decisions (agreed 2026-08-18)

1. **Priority v1 becomes the explainable core; `agendaScoring` delegates to it.** Not a second
   scorer. Two competing rankings in one product is a hazard with no good answer to "which order
   does the user actually see", and the existing logic is live and tested.
2. **The legacy counter migration is deferred entirely.** Priority reads `aggregateFeedback`
   directly as a new consumer. The two legacy readers (`adaptiveService`, `pressureService`) and the
   Sprint 03 dual-write are untouched.
3. **`dependency` and `effort` are explicit unknowns.** No source state exists for them, and #17
   requires that each feature trace to source state and that nothing unsupported be invented.

## Architecture

| Component | Path | Owner |
|---|---|---|
| Shared contract | `src/contracts/v1/priorityContracts.ts` | written first, before parallel work |
| Feature extraction | `lib/priority/priorityFeatures.ts` | #17 |
| Scoring core + breakdown | `lib/priority/priorityScorer.ts` | #18 |
| Scoring policy config | `lib/priority/priorityPolicy.ts` | #18 |
| Rubric, seed set, agreement format | `lib/priority/rubric/**`, `tests/fixtures/` | #19 |
| **`agendaScoring` delegation** | `lib/utils/agendaScoring.ts` | **merge-time, centrally** |

The last row is deliberate. It is live shared code with existing consumers and tests — the same
class of risky integration as Sprint 03's dual-write, which is why no parallel agent touches it.

## Component 1 — Feature extraction (#17)

```ts
export interface PriorityFeatures {
  readonly version: typeof PRIORITY_SCHEMA_VERSION;
  readonly commitmentId: string;
  readonly computedAt: string;
  readonly urgency: PriorityFeature<UrgencyFeature>;
  readonly importance: PriorityFeature<ImportanceFeature>;
  readonly lateness: PriorityFeature<LatenessFeature>;
  readonly userPressure: PriorityFeature<UserPressureFeature>;
  readonly dependency: PriorityFeature<never>;  // always unknown in v1
  readonly effort: PriorityFeature<never>;      // always unknown in v1
}
```

Each feature carries an **evidence link** naming the source it was derived from — the commitment
field, reminder ids, or the feedback aggregate window — so "each feature traces to source state" is
a property of the data rather than a claim in a comment.

`dependency` and `effort` are `{ known: false, reason: 'NO_DATA' }` in every case, with the contract
documenting that `Commitment` has no such field. Returning zero would be inventing a signal; the
`Field<T>` shape from Sprint 02 exists exactly so absence cannot be misread as a low value.

**Missing-value policy**: a feature whose inputs are absent is unknown, never defaulted. The scorer
must therefore handle unknown features explicitly rather than coercing them, and a feature that
becomes knowable later changes ranking without any consumer needing to distinguish "new" from
"previously zero".

Extraction is pure, takes an explicit `now`, and calls no LLM — #17 states that as an acceptance
criterion and everything here is arithmetic over `DomainState` and Sprint 03 aggregates.

### Mapping to the existing scorer

The four knowable features correspond one-to-one with the existing band components, which is what
makes delegation behaviour-preserving. Stated explicitly because #17 and #18 are built in parallel
and would otherwise be free to pair them differently:

| #17 feature | existing `agendaScoring` component | derived from |
|---|---|---|
| `urgency` | `reasonTimeScore` | overdue duration, or closeness within the due-soon window |
| `importance` | `importanceScore` | `commitment.priority.level` |
| `lateness` | `repeatedDelayScore` | snoozed reminders, `postponedUntil`, deferred status |
| `userPressure` | `ignoredScore` | ignored reminders and ack state, with a 24h recency window |

`reason_base` is not a feature: it is a band selected by the commitment's reason
(overdue/due_soon/active/pending), not a property extracted from it, so it appears in the score
breakdown only.

## Component 2 — Scoring (#18)

### The reconciliation problem

"Score explanations reconcile numerically" is the hard criterion, and the existing composition makes
it non-trivial. The four band components can reach **1350** (420 + 180 + 510 + 240) against a band
cap of **999**. A breakdown that simply lists the four contributions would over-report by up to 351
points — and the clamp binds precisely on the most overdue, highest-priority, most-repeatedly-delayed
items, which is exactly where a user most needs the explanation to be true.

So the breakdown represents the clamp as an explicit term:

```ts
export interface ScoreComponent {
  readonly code: ScoreComponentCode;   // 'reason_base' | 'urgency' | 'importance' | ... | 'band_clamp'
  readonly points: number;             // signed; band_clamp is negative when it binds
  readonly evidence: string | null;
}

export interface PriorityScore {
  readonly commitmentId: string;
  readonly total: number;
  readonly components: readonly ScoreComponent[];
  readonly reasonCodes: readonly ReasonCode[];
  readonly policyVersion: string;
}
```

**The breakdown is the computation, not a reconstruction of it.** The total is produced by summing
the components that are emitted, rather than computed separately and then explained. An explanation
assembled alongside a total it does not produce can drift from that total silently; one that *is*
the total cannot. The invariant to test is `sum(components.points) === total`, and it must hold
including when both clamps bind.

### Policy, ties, and overrides

- **Configurable policy** — weights and base scores live in a versioned config object rather than as
  literals, and `policyVersion` travels with every score so a stored ranking says which policy
  produced it.
- **Stable tie-breaking** — equal totals break on `commitmentId` using code-unit comparison, never
  `localeCompare`, which is locale-dependent. (A review last sprint found exactly this bug in
  timestamp ordering.)
- **Hard constraints override soft preferences** — overrides are applied as a distinct pass after
  scoring and are recorded in `reasonCodes`, so an override is visible in the explanation rather than
  hidden inside a weight. A weight large enough to always dominate would satisfy the ordering while
  making the explanation useless.

### Delegation (merge-time, central)

`calculateAgendaUrgencyScore(input): number` keeps its exact signature and becomes a thin wrapper:
it builds `PriorityFeatures` from its `AgendaScoringInput`, scores them, and returns `.total`. One
implementation, existing callers untouched.

The scorer therefore consumes **`PriorityFeatures`, never `DomainState` directly** — that separation
is the whole point of splitting #17 from #18, and it keeps the scorer testable against a feature
vector without constructing domain state.

The existing `tests/agendaScoring.test.ts` and `tests/agendaService.test.ts` are the regression
check: if delegation changes any score, they fail, and that is a real signal rather than something
to update.

## Component 3 — Rubric and seed set (#19)

Per the scope split already recorded on the issue:

**Buildable now**
- Annotation rubric as a written scoring spec with worked examples, authored rather than collected.
- A balanced seed set generated across languages (ar/he/en/mixed) and load patterns, following the
  Lane C corpus convention (`tests/quality/scenarios/alphaQualityScenarios.ts`) and carrying the
  established `SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE` header.
- The inter-annotator agreement **report format** and the scoring code that would consume real
  judgments, including disagreement handling and the "unresolved" state for genuinely ambiguous
  pairs.

**Stub — needs real humans later**
- Running the rubric past annotators and collecting agreement data. The ingestion point ships
  **empty and wired**: schema, loader, and validation present, with zero rows.

**The failure mode to avoid is fabrication.** Generating plausible-looking judgment rows would
produce a dataset that reads as human evidence and is not. The loader must therefore report an empty
corpus honestly, and a test asserts the shipped judgment set is empty rather than merely valid.

## Testing

Repo conventions: `node:test` + `node:assert/strict`, flat `test(...)`, `.ts` extensions in test
imports. **New test files must be registered in `package.json`** — handled centrally at merge, not
by the parallel agents.

Two things are explicitly not delegated:

1. **The `agendaScoring` delegation**, for the reasons above.
2. **A cross-track test** running #19's seed set through #17's features into #18's scorer. Sprint 02
   and Sprint 03 both showed that per-track suites can all pass while the tracks disagree; the
   integration is where that surfaces.

**Mutation testing is required, not suggested**, on the reconciliation invariant specifically. The
technique found three genuine gaps in Sprint 03's aggregation, including a validator that could not
be shown to fail. At minimum: break the clamp term, drop a component from the breakdown, and make
the total computed independently of the components — each must turn a test red.

## Execution plan

1. Write and commit `src/contracts/v1/priorityContracts.ts`.
2. Three parallel agents in isolated worktrees on disjoint directories: #17 → `priorityFeatures.ts`,
   #18 → `priorityScorer.ts` + `priorityPolicy.ts`, #19 → `rubric/**` + fixtures.
3. Merge; centrally own the `agendaScoring` delegation, `package.json`, and the `moduleContracts.ts`
   `priority` entry.
4. Cross-track test.
5. `/code-review` early and in the foreground — it was interrupted twice in the background last
   sprint and that branch shipped without an independent review.
6. Full verification, then PR.

## Non-goals

- Migrating `adaptiveService` / `pressureService` off the legacy counters, or retiring the Sprint 03
  dual-write.
- Extending `FeedbackOutcome` to cover clarification signals.
- Any LLM or model-assisted ranking — #17 names "no LLM is required" as an acceptance criterion, and
  #19 exists precisely to define judgment data *before* model-assisted ranking is considered.
- Collecting real annotations.
- Surfacing priority in the mobile UI — no UI work in this sprint.
- Direct model writes to canonical user state.

## Risks

- **Delegation changes a live ranking.** The refactor is intended to be behaviour-preserving, but
  the existing scorer is what users see today. Mitigation: `calculateAgendaUrgencyScore` keeps its
  signature, and the existing agenda tests must pass unchanged; any diff in score is treated as a
  defect in the refactor rather than an improvement to accept.
- **The clamp makes reconciliation subtle.** Mitigation: the clamp is an explicit signed component,
  and mutation tests specifically target it.
- **#19 could fabricate evidence.** Mitigation: the shipped judgment set is asserted empty, and the
  synthetic header marks the seed set as QA-only.
