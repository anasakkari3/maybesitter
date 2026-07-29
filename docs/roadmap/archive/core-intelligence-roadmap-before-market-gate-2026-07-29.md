# Core Intelligence roadmap before Market Evidence Gate

> **Immutable historical snapshot — captured 2026-07-29 before the NARROW AND TEST roadmap migration.**
>
> This document preserves the original roadmap state for auditability. It must not be edited to match later strategy. GitHub issue history remains the authoritative record of subsequent changes.

## Original Issue #49

**Title:** [Roadmap] Core Intelligence delivery map — 12 sprints / 4 parallel slots

## Goal
Deliver the MaybeSitter Core Intelligence System as an explainable, user-controlled pipeline:

`Capture → Life-State & Memory → Priority → Planning → Recommendation → Coaching → Confirmation → Feedback`

## How to use this roadmap
1. Open the current sprint milestone.
2. Start any implementation issue whose previous review gate is GO. The three slots inside a sprint are designed to run in parallel.
3. Do not bypass issue-level prerequisites or broaden scope across module contracts.
4. Finish the sprint with its Review Gate issue. The next sprint is blocked until that decision is recorded.
5. Model output is always a proposal; deterministic services validate hard constraints and persistence requires explicit product rules/confirmation.

## Timeline
| Sprint | Window | Focus | Review gate |
|---|---|---|---|
| S00 | Aug 3–16, 2026 | Foundations | #4 |
| S01 | Aug 17–30, 2026 | Capture Quality Gate | #8 |
| S02 | Aug 31–Sep 13, 2026 | Life-State & Memory | #12 |
| S03 | Sep 14–27, 2026 | Feedback Events | #16 |
| S04 | Sep 28–Oct 11, 2026 | Priority Engine v1 | #20 |
| S05 | Oct 12–25, 2026 | Priority Calibration | #24 |
| S06 | Oct 26–Nov 8, 2026 | Decomposition | #28 |
| S07 | Nov 9–22, 2026 | Planning Engine | #32 |
| S08 | Nov 23–Dec 6, 2026 | Recommendations | #36 |
| S09 | Dec 7–20, 2026 | Coaching & Safety | #40 |
| S10 | Dec 21, 2026–Jan 3, 2027 | Personalization Controls | #44 |
| S11 | Jan 4–17, 2027 | Shadow Release | #48 |

## Permanent architecture rules
- Models never write canonical state directly.
- Private runtime memory is not fine-tuning data.
- Hard constraints and time calculations are deterministic.
- Recommendations carry evidence and explanations.
- Memory carries source, confidence, freshness, scope, and user controls.
- Behavioral learning is event-based, reversible, and inspectable.
- Locked tests, provenance, leakage checks, safety gates, and rollback evidence are release requirements.

## Definition of ready
An issue is ready only when its dependency gate is GO, its contracts are known, and test/evaluation inputs exist.

## Definition of done
Code/data is versioned; tests and evaluation gates pass; privacy/safety checks pass; observability and rollback are documented; evidence is attached; and the sprint Review Gate accepts it.

## Original Issues #1–#48

| Issue | Title | Milestone | Labels | Original dependencies |
|---:|---|---|---|---|
| #1 | [S00][Backend] Architecture boundaries and module contracts | Sprint 00 — Foundations | roadmap, type: implementation, track: backend, area: integration | Depends on: none — roadmap entry point. |
| #2 | [S00][Model/Data] Dataset registry and evaluation governance | Sprint 00 — Foundations | roadmap, type: implementation, track: model-data, area: evaluation | Depends on: none — roadmap entry point. |
| #3 | [S00][Quality] Feature flags, audit events, and kill switches | Sprint 00 — Foundations | roadmap, type: implementation, track: quality, area: safety | Depends on: none — roadmap entry point. |
| #4 | [S00][Review Gate] Foundations evidence, integration, and go/no-go | Sprint 00 — Foundations | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #1 - [ ] #2 - [ ] #3 |
| #5 | [S01][Model/Data] Close calibration consistency and freeze Capture Gold | Sprint 01 — Capture Quality Gate | roadmap, type: implementation, track: model-data, area: capture | Depends on: #4 (previous sprint review gate). |
| #6 | [S01][Backend] Harden Capture service boundary and persistence adapter | Sprint 01 — Capture Quality Gate | roadmap, type: implementation, track: backend, area: capture | Depends on: #4 (previous sprint review gate). |
| #7 | [S01][Quality] Build Capture regression and adversarial evaluation runner | Sprint 01 — Capture Quality Gate | roadmap, type: implementation, track: quality, area: evaluation | Depends on: #4 (previous sprint review gate). |
| #8 | [S01][Review Gate] Capture Quality Gate evidence, integration, and go/no-go | Sprint 01 — Capture Quality Gate | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #5 - [ ] #6 - [ ] #7 |
| #9 | [S02][Backend] Implement canonical Life-State projection | Sprint 02 — Life-State & Memory | roadmap, type: implementation, track: backend, area: life-state | Depends on: #8 (previous sprint review gate). |
| #10 | [S02][Backend] Implement provenance-aware Memory store | Sprint 02 — Life-State & Memory | roadmap, type: implementation, track: backend, area: memory | Depends on: #8 (previous sprint review gate). |
| #11 | [S02][Model/Data] Create Life-State and Memory contract fixtures | Sprint 02 — Life-State & Memory | roadmap, type: implementation, track: model-data, area: evaluation | Depends on: #8 (previous sprint review gate). |
| #12 | [S02][Review Gate] Life-State & Memory evidence, integration, and go/no-go | Sprint 02 — Life-State & Memory | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #9 - [ ] #10 - [ ] #11 |
| #13 | [S03][Backend] Define and persist behavioral Feedback events | Sprint 03 — Feedback Events | roadmap, type: implementation, track: backend, area: feedback | Depends on: #12 (previous sprint review gate). |
| #14 | [S03][Backend] Build feedback aggregation and feature views | Sprint 03 — Feedback Events | roadmap, type: implementation, track: backend, area: feedback | Depends on: #12 (previous sprint review gate). |
| #15 | [S03][Product] Add feedback transparency and undo controls | Sprint 03 — Feedback Events | roadmap, type: implementation, track: product, area: feedback | Depends on: #12 (previous sprint review gate). |
| #16 | [S03][Review Gate] Feedback Events evidence, integration, and go/no-go | Sprint 03 — Feedback Events | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #13 - [ ] #14 - [ ] #15 |
| #17 | [S04][Backend] Implement deterministic priority feature extraction | Sprint 04 — Priority Engine v1 | roadmap, type: implementation, track: backend, area: priority | Depends on: #16 (previous sprint review gate). |
| #18 | [S04][Backend] Implement explainable Priority scorer v1 | Sprint 04 — Priority Engine v1 | roadmap, type: implementation, track: backend, area: priority | Depends on: #16 (previous sprint review gate). |
| #19 | [S04][Model/Data] Create Priority evaluation seed set and rubric | Sprint 04 — Priority Engine v1 | roadmap, type: implementation, track: model-data, area: priority | Depends on: #16 (previous sprint review gate). |
| #20 | [S04][Review Gate] Priority Engine v1 evidence, integration, and go/no-go | Sprint 04 — Priority Engine v1 | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #17 - [ ] #18 - [ ] #19 |
| #21 | [S05][Model/Data] Run pairwise and listwise Priority annotation round | Sprint 05 — Priority Calibration | roadmap, type: implementation, track: model-data, area: priority | Depends on: #20 (previous sprint review gate). |
| #22 | [S05][Backend] Calibrate Priority policy against reviewed judgments | Sprint 05 — Priority Calibration | roadmap, type: implementation, track: backend, area: priority | Depends on: #20 (previous sprint review gate). |
| #23 | [S05][Quality] Add Priority shadow comparison telemetry | Sprint 05 — Priority Calibration | roadmap, type: implementation, track: quality, area: evaluation | Depends on: #20 (previous sprint review gate). |
| #24 | [S05][Review Gate] Priority Calibration evidence, integration, and go/no-go | Sprint 05 — Priority Calibration | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #21 - [ ] #22 - [ ] #23 |
| #25 | [S06][Backend] Define Decomposition proposal and confirmation contracts | Sprint 06 — Decomposition | roadmap, type: implementation, track: backend, area: decomposition | Depends on: #24 (previous sprint review gate). |
| #26 | [S06][Model/Data] Build reviewed Decomposition dataset and evaluator | Sprint 06 — Decomposition | roadmap, type: implementation, track: model-data, area: decomposition | Depends on: #24 (previous sprint review gate). |
| #27 | [S06][Backend] Implement Decomposition proposal engine and validator | Sprint 06 — Decomposition | roadmap, type: implementation, track: backend, area: decomposition | Depends on: #24 (previous sprint review gate). |
| #28 | [S06][Review Gate] Decomposition evidence, integration, and go/no-go | Sprint 06 — Decomposition | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #25 - [ ] #26 - [ ] #27 |
| #29 | [S07][Backend] Implement availability and constraint model | Sprint 07 — Planning Engine | roadmap, type: implementation, track: backend, area: planning | Depends on: #28 (previous sprint review gate). |
| #30 | [S07][Backend] Implement deterministic scheduler v1 | Sprint 07 — Planning Engine | roadmap, type: implementation, track: backend, area: planning | Depends on: #28 (previous sprint review gate). |
| #31 | [S07][Model/Data] Create Planning scenarios and feasibility oracle | Sprint 07 — Planning Engine | roadmap, type: implementation, track: model-data, area: evaluation | Depends on: #28 (previous sprint review gate). |
| #32 | [S07][Review Gate] Planning Engine evidence, integration, and go/no-go | Sprint 07 — Planning Engine | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #29 - [ ] #30 - [ ] #31 |
| #33 | [S08][Backend] Define Recommendation contract and evidence graph | Sprint 08 — Recommendations | roadmap, type: implementation, track: backend, area: recommendation | Depends on: #32 (previous sprint review gate). |
| #34 | [S08][Backend] Implement Recommendation selector v1 | Sprint 08 — Recommendations | roadmap, type: implementation, track: backend, area: recommendation | Depends on: #32 (previous sprint review gate). |
| #35 | [S08][Product] Build recommendation review interaction | Sprint 08 — Recommendations | roadmap, type: implementation, track: product, area: recommendation | Depends on: #32 (previous sprint review gate). |
| #36 | [S08][Review Gate] Recommendations evidence, integration, and go/no-go | Sprint 08 — Recommendations | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #33 - [ ] #34 - [ ] #35 |
| #37 | [S09][Model/Data] Create Coaching tone and faithfulness evaluation set | Sprint 09 — Coaching & Safety | roadmap, type: implementation, track: model-data, area: coaching | Depends on: #36 (previous sprint review gate). |
| #38 | [S09][Backend] Implement Coaching response planner and realizer | Sprint 09 — Coaching & Safety | roadmap, type: implementation, track: backend, area: coaching | Depends on: #36 (previous sprint review gate). |
| #39 | [S09][Quality] Implement cross-module Safety policy gateway | Sprint 09 — Coaching & Safety | roadmap, type: implementation, track: quality, area: safety | Depends on: #36 (previous sprint review gate). |
| #40 | [S09][Review Gate] Coaching & Safety evidence, integration, and go/no-go | Sprint 09 — Coaching & Safety | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #37 - [ ] #38 - [ ] #39 |
| #41 | [S10][Backend] Implement behavior-derived personalization profile | Sprint 10 — Personalization Controls | roadmap, type: implementation, track: backend, area: memory | Depends on: #40 (previous sprint review gate). |
| #42 | [S10][Product] Add Memory and personalization control center | Sprint 10 — Personalization Controls | roadmap, type: implementation, track: product, area: memory | Depends on: #40 (previous sprint review gate). |
| #43 | [S10][Quality] Evaluate personalization benefit and harm | Sprint 10 — Personalization Controls | roadmap, type: implementation, track: quality, area: evaluation | Depends on: #40 (previous sprint review gate). |
| #44 | [S10][Review Gate] Personalization Controls evidence, integration, and go/no-go | Sprint 10 — Personalization Controls | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #41 - [ ] #42 - [ ] #43 |
| #45 | [S11][Backend] Integrate end-to-end intelligence pipeline in shadow mode | Sprint 11 — Shadow Release | roadmap, type: implementation, track: backend, area: integration | Depends on: #44 (previous sprint review gate). |
| #46 | [S11][Quality] Build operational dashboards, SLOs, and rollback drill | Sprint 11 — Shadow Release | roadmap, type: implementation, track: quality, area: integration | Depends on: #44 (previous sprint review gate). |
| #47 | [S11][Product] Run controlled internal release and decision study | Sprint 11 — Shadow Release | roadmap, type: implementation, track: product, area: integration | Depends on: #44 (previous sprint review gate). |
| #48 | [S11][Review Gate] Shadow Release evidence, integration, and go/no-go | Sprint 11 — Shadow Release | roadmap, type: review-gate, track: quality, area: evaluation | - [ ] #45 - [ ] #46 - [ ] #47 |

## Snapshot integrity

- Source repository: https://github.com/anasakkari3/maybesitter
- Issues captured: #1–#49
- Snapshot date: 2026-07-29
- The original Issue #49 sprint table and full body appear above without strategic rewriting.
- Issues were not deleted or closed as part of creating this archive.
