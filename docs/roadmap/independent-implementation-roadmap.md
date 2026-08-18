# Independent Implementation Roadmap

Generated 2026-08-18 from the full open-issue backlog of [anasakkari3/maybesitter](https://github.com/anasakkari3/maybesitter). Every issue below is rewritten to remove human-approval gates, live market-evidence gates, and dependencies on real-user testing — each is independently implementable now, with no waiting on a decision, a pilot, or a manual review. "Verification" for these issues means automated tests and agent-driven checks (unit/integration, simulator- or CLI-driven runs), never a live user or a human sign-off.

Background/context (left untouched, informational only): [#49 — Conditional Core Intelligence roadmap](https://github.com/anasakkari3/maybesitter/issues/49).

## Excluded (human/business-gated, not implementation work)

These 17 issues stayed **open** but are labeled `excluded:human-gate` and out of scope for this roadmap — their deliverable is a decision, a live experiment, or real-user exposure, not code.

| # | Title | Why excluded |
|---|---|---|
| #12 | [S02][Review Gate] Life-State & Memory evidence, integration, and go/no-go | Review gate |
| #16 | [S03][Review Gate] Feedback Events evidence, integration, and go/no-go | Review gate |
| #20 | [S04][Review Gate] Priority Engine v1 evidence, integration, and go/no-go | Review gate |
| #24 | [S05][Review Gate] Priority Calibration evidence, integration, and go/no-go | Review gate |
| #28 | [S06][Review Gate] Decomposition evidence, integration, and go/no-go | Review gate |
| #32 | [S07][Review Gate] Planning Engine evidence, integration, and go/no-go | Review gate |
| #36 | [S08][Review Gate] Recommendations evidence, integration, and go/no-go | Review gate |
| #40 | [S09][Review Gate] Coaching & Safety evidence, integration, and go/no-go | Review gate |
| #44 | [S10][Review Gate] Personalization Controls evidence, integration, and go/no-go | Review gate |
| #48 | [S11][Review Gate] Shadow Release evidence, integration, and go/no-go | Review gate |
| #55 | [V03][Product] Run a closed one-next-step pilot with progressive trust controls | Live pilot (25-40 real users) |
| #57 | [V03][Review Gate] Pilot activation, trust, and early utility decision | Review gate |
| #58 | [V04][Research] Measure Week-4 and Week-8 retention and behavioral outcomes | Live retention experiment |
| #59 | [V04][Business] Test pricing and real willingness-to-pay | Live pricing experiment |
| #60 | [V04][Product/Privacy] Test progressive data-sharing and calendar trust | Live trust experiment |
| #61 | [V04][Review Gate] Market Evidence decision — GO / CONDITIONAL GO / PIVOT / HOLD / KILL | Review gate (market-evidence) |
| #92 | [V03][Pre-Pilot] Alpha hardening phase umbrella — usable, inspectable, measurable before #55 | Pre-pilot readiness gate (umbrella) |

## Implementation roadmap (34 issues, independent, gate-free)

### Sprint 02 — Life-State & Memory ✅ DONE

Merged 2026-08-18 via [#99](https://github.com/anasakkari3/maybesitter/pull/99). Design:
`docs/superpowers/specs/2026-08-18-sprint-02-life-state-memory-design.md`.

- **[#9](https://github.com/anasakkari3/maybesitter/issues/9) — [S02][Backend] Implement canonical Life-State projection** — done, `lib/lifeState/`
  Create a deterministic read model for commitments, availability, load, and recent outcomes.
- **[#10](https://github.com/anasakkari3/maybesitter/issues/10) — [S02][Backend] Implement provenance-aware Memory store** — done, `lib/runtimeMemory/`
  Store runtime memories with source, confidence, freshness, scope, and revocation.
- **[#11](https://github.com/anasakkari3/maybesitter/issues/11) — [S02][Model/Data] Create Life-State and Memory contract fixtures** — done, `tests/fixtures/`
  Build multilingual fixtures that test missing, stale, conflicting, and sensitive context.

**Contracts now available to later sprints** — `src/contracts/v1/lifeStateContracts.ts` and
`src/contracts/v1/memoryContracts.ts`. The `lifeState` and `memory` entries in `moduleContracts.ts`
are no longer placeholders.

**Lesson for the remaining sprints.** Writing the shared contracts before starting parallel work
prevented merge conflicts, but did not prevent the three modules from *interpreting* the contract
three different ways: 91 tests passed while they disagreed, because the fixture corpus was data that
nothing executed. Every sprint that splits into parallel tracks should end with an integration test
that runs one track's fixtures against another track's real implementation — that step, not the
per-track suites, is what found the disagreements.

### Sprint 03 — Feedback Events ✅ DONE

Merged 2026-08-18 via [#101](https://github.com/anasakkari3/maybesitter/pull/101). Design:
`docs/superpowers/specs/2026-08-18-sprint-03-feedback-events-design.md`.

**Contracts now available to later sprints** — `src/contracts/v1/feedbackContracts.ts`.

**Carried forward.** The legacy `behaviorFeedbackService` counters are still authoritative: outcomes
are dual-written to the event log beside them, and the six modules that read the counters were
deliberately not migrated. Whichever sprint first needs behavioural features (Priority, S04-05)
should migrate those readers to `aggregateFeedback` and retire the dual-write.

**Lesson.** Sprint 02's lesson held again, and one more surfaced: `revokeForScope` took three
positional strings, so swapping two of them type-checked cleanly — and the first draft of the
cross-track test did exactly that, making the *authorization* test pass for the wrong reason. Where
adjacent same-typed parameters guard a security boundary, name them.

- **[#13](https://github.com/anasakkari3/maybesitter/issues/13) — [S03][Backend] Define and persist behavioral Feedback events**
  Record accept, edit, reject, defer, complete, ignore, and undo outcomes as append-only events.
- **[#14](https://github.com/anasakkari3/maybesitter/issues/14) — [S03][Backend] Build feedback aggregation and feature views**
  Derive explainable behavioral features for later ranking without changing canonical history.
- **[#15](https://github.com/anasakkari3/maybesitter/issues/15) — [S03][Product] Add feedback transparency and undo controls**
  Let users inspect why the system learned something and revoke incorrect signals.

### Sprint 04 — Priority Engine v1 ✅ DONE

Merged 2026-08-19 via [#103](https://github.com/anasakkari3/maybesitter/pull/103). Design:
`docs/superpowers/specs/2026-08-18-sprint-04-priority-engine-design.md`.

**Contracts now available** — `src/contracts/v1/priorityContracts.ts`. `lib/utils/agendaScoring` now
delegates to `lib/priority/**`, so the product has one ranking implementation.

**Carried forward, in priority order.**
1. `rankPriorities` has no non-test caller: `agendaScoring` returns `.total` only, so the
   hard-constraint tier affects no ordering a user sees. Sprint 05 is where it gets exercised.
2. The priority judgment corpus (`data/quality/priority-judgments.json`) is **empty by design**.
   Sprint 05 calibrates against it, so it needs real annotations first — fabricating rows would
   train the ranking on invented preferences.
3. Still outstanding from Sprint 03: the `behaviorFeedbackService` dual-write and its two readers.
   Priority did *not* consume the feedback aggregates — `FeedbackAggregates` is scope-wide with no
   per-subject breakdown, so attributing a scope's counts to one commitment would invent a signal.
   Consuming them needs a per-subject aggregate.
4. A latent bug in pre-existing code, reported not replicated: `agendaScoring`'s old
   `parseTime(a) || parseTime(b)` chain treated a `1970-01-01T00:00:00Z` timestamp as falsy. The new
   path handles it correctly, which is the only behavioural divergence between them.

**Lesson.** Delegating to a rewritten core is only as safe as the evidence that the two agree. Hand-
picked equivalence cases were not enough: a differential fuzz of the delegated path against the
original arithmetic over 260,000 randomized inputs is what actually established it, and it is cheap.
Where a sprint replaces live logic, fuzz the replacement against what it replaces.

- **[#17](https://github.com/anasakkari3/maybesitter/issues/17) — [S04][Backend] Implement deterministic priority feature extraction**
  Compute urgency, importance, dependency, effort, lateness, and user-pressure features from trusted state.
- **[#18](https://github.com/anasakkari3/maybesitter/issues/18) — [S04][Backend] Implement explainable Priority scorer v1**
  Rank commitments using a configurable deterministic scoring policy.
- **[#19](https://github.com/anasakkari3/maybesitter/issues/19) — [S04][Model/Data] Create Priority evaluation seed set and rubric** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Define pairwise/listwise judgment data and disagreement handling before model-assisted ranking.

### Sprint 05 — Priority Calibration

_Advisory: calibrates the Sprint 04 Priority scorer; can be built against a stub scorer interface._

- **[#21](https://github.com/anasakkari3/maybesitter/issues/21) — [S05][Model/Data] Run pairwise and listwise Priority annotation round** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Collect reviewed ranking judgments with rationales and hard-constraint flags.
- **[#22](https://github.com/anasakkari3/maybesitter/issues/22) — [S05][Backend] Calibrate Priority policy against reviewed judgments**
  Tune configurable weights and thresholds without weakening deterministic constraints.
- **[#23](https://github.com/anasakkari3/maybesitter/issues/23) — [S05][Quality] Add Priority shadow comparison telemetry**
  Compare current ordering and Priority v1 without changing what users see.

### Sprint 06 — Decomposition

_Advisory: operates on commitments from Life-State (Sprint 02); stub/mock otherwise._

- **[#25](https://github.com/anasakkari3/maybesitter/issues/25) — [S06][Backend] Define Decomposition proposal and confirmation contracts**
  Represent multi-step proposals without overwriting the original commitment.
- **[#26](https://github.com/anasakkari3/maybesitter/issues/26) — [S06][Model/Data] Build reviewed Decomposition dataset and evaluator** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Create multilingual examples for atomic, multi-step, and should-not-split commitments.
- **[#27](https://github.com/anasakkari3/maybesitter/issues/27) — [S06][Backend] Implement Decomposition proposal engine and validator**
  Generate candidate steps and reject structurally or semantically unsafe proposals.

### Sprint 07 — Planning Engine

_Advisory: schedules against Priority output (Sprint 04-05) and Decomposition (Sprint 06); stub/mock otherwise._

- **[#29](https://github.com/anasakkari3/maybesitter/issues/29) — [S07][Backend] Implement availability and constraint model**
  Normalize working windows, fixed events, deadlines, effort, dependencies, and buffers.
- **[#30](https://github.com/anasakkari3/maybesitter/issues/30) — [S07][Backend] Implement deterministic scheduler v1**
  Produce a feasible plan using priorities and constraints with stable, explainable choices.
- **[#31](https://github.com/anasakkari3/maybesitter/issues/31) — [S07][Model/Data] Create Planning scenarios and feasibility oracle**
  Build scenario-based evaluation for overload, conflicts, multilingual dates, and changes.

### Sprint 08 — Recommendations

_Advisory: selects from Planning Engine output (Sprint 07); stub/mock otherwise._

- **[#33](https://github.com/anasakkari3/maybesitter/issues/33) — [S08][Backend] Define Recommendation contract and evidence graph**
  Represent next-action recommendations with source facts, alternatives, confidence, and expiry.
- **[#34](https://github.com/anasakkari3/maybesitter/issues/34) — [S08][Backend] Implement Recommendation selector v1**
  Select a small set of next actions from priority and plan outputs.
- **[#35](https://github.com/anasakkari3/maybesitter/issues/35) — [S08][Product] Build recommendation review interaction**
  Present recommendations as proposals with explanation, edit, dismiss, and accept paths.

### Sprint 09 — Coaching & Safety

_Advisory: wraps Recommendation output (Sprint 08); stub/mock otherwise._

- **[#37](https://github.com/anasakkari3/maybesitter/issues/37) — [S09][Model/Data] Create Coaching tone and faithfulness evaluation set** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Evaluate helpfulness, calmness, non-shaming language, and factual faithfulness across languages.
- **[#38](https://github.com/anasakkari3/maybesitter/issues/38) — [S09][Backend] Implement Coaching response planner and realizer**
  Turn approved recommendation facts into concise coaching without adding new facts.
- **[#39](https://github.com/anasakkari3/maybesitter/issues/39) — [S09][Quality] Implement cross-module Safety policy gateway**
  Enforce privacy, harmful-pressure, injection, hallucinated-time, and persistence boundaries.

### Sprint 10 — Personalization Controls

_Advisory: layers on Life-State/Memory (Sprint 02) and Feedback (Sprint 03); stub/mock otherwise._

- **[#41](https://github.com/anasakkari3/maybesitter/issues/41) — [S10][Backend] Implement behavior-derived personalization profile**
  Derive bounded preferences from feedback aggregates with decay, confidence, and evidence.
- **[#42](https://github.com/anasakkari3/maybesitter/issues/42) — [S10][Product] Add Memory and personalization control center**
  Give users visibility, correction, export, disable, and deletion controls.
- **[#43](https://github.com/anasakkari3/maybesitter/issues/43) — [S10][Quality] Evaluate personalization benefit and harm** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Measure usefulness, stability, overfitting, unfair pressure, and cold-start behavior.

### Sprint 11 — Shadow Release

_Advisory: integrates every module above end-to-end in shadow mode; build incrementally against whichever module interfaces exist, stubbing the rest._

- **[#45](https://github.com/anasakkari3/maybesitter/issues/45) — [S11][Backend] Integrate end-to-end intelligence pipeline in shadow mode**
  Run Capture through Coaching behind flags without changing user-visible behavior or persistence.
- **[#46](https://github.com/anasakkari3/maybesitter/issues/46) — [S11][Quality] Build operational dashboards, SLOs, and rollback drill**
  Make reliability, drift, safety, latency, and cost visible before controlled exposure.
- **[#47](https://github.com/anasakkari3/maybesitter/issues/47) — [S11][Product] Run controlled internal release and decision study** — **scope split applied** (buildable-now vs. human-input-stub, see issue body)
  Expose the pipeline to a consented internal cohort with staged limits and structured feedback.

### V03 Pre-Pilot — Lane A: Product Reliability

- **[#93](https://github.com/anasakkari3/maybesitter/issues/93) — [V03][Pre-Pilot][Lane A] Product reliability audit and core-flow fixes**

### V03 Pre-Pilot — Lane B: AI Observability / Reviewable Trace

- **[#94](https://github.com/anasakkari3/maybesitter/issues/94) — [V03][Pre-Pilot][Lane B] Privacy-conscious reviewable AI interaction trace**

### V03 Pre-Pilot — Lane C: AI Quality Evaluation Harness

- **[#95](https://github.com/anasakkari3/maybesitter/issues/95) — [V03][Pre-Pilot][Lane C] Internal AI quality evaluation harness (AR/HE/EN)**

### V03 Pre-Pilot — Lane D: Dogfood UX and Review

- **[#96](https://github.com/anasakkari3/maybesitter/issues/96) — [V03][Pre-Pilot][Lane D] Dogfood UX, feedback flags, and internal review workflow**

## Notes

- Cross-module "Advisory" notes above are non-blocking. Where a later module's design assumes an earlier module's output, stub or mock that interface rather than waiting for the earlier module to be finished.
- The 6 issues marked "scope split applied" originally called for collecting real human judgments (annotation rounds, human-reviewed datasets, live cohort studies). Each is now scoped to the buildable infrastructure (schemas, pipelines, rubrics-as-code, harnesses) with the human-input step stubbed as a clearly documented follow-up, not part of this implementation pass.
- Original sprint "Window" dates in each issue are leftover artifacts of the old gated calendar and no longer apply — these issues can be picked up in any order.

