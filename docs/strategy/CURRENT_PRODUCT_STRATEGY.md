# Current Product Strategy

**Strategy verdict: NARROW AND TEST**  
**Latest strategy review:** 2026-07-29  
**Master roadmap:** [Issue #49](https://github.com/anasakkari3/maybesitter/issues/49)  
**Current stage:** Stage A — Foundations/Capture, followed by the Narrow Next-Step Wedge

> **Long-term conditional vision. Not the currently validated product scope.**

## 1. Long-term North Star

The possible long-term architecture is:

`Capture → Life-State & Memory → Priority → Planning → Recommendation → Coaching → Confirmation → Feedback`

This remains a strategic direction. It is not an automatic implementation sequence. Every advanced module requires both the final Market Evidence Gate and module-specific product evidence.

## 2. Current wedge

> MaybeSitter converts messy thoughts and commitments into one clear, realistic next step, with a short explanation and explicit user control.

## 3. Target commercial cohort

Adults who strongly identify with ADHD-related executive dysfunction, task-initiation difficulty, overwhelm, or decision fatigue, particularly people who already pay for productivity tools, coaching, or related services. This describes a research cohort and product problem; it is not diagnosis or treatment positioning.

## 4. Fast research cohort

Arabic/Hebrew bilingual students in Israel support fast testing of mixed-language capture, trust, usefulness, and notification tolerance. Results must be segmented and must not be treated automatically as global market evidence.

## 5. Primary user problem

When commitments are scattered or mentally overwhelming, the user struggles to convert them into one realistic action they can begin now. The product must prove this is frequent, costly, and inadequately served by existing workflows.

## 6. Product loop

`Free input → Commitment extraction → Human review → One next-step proposal → Accept/Edit/Defer/Dismiss/Done → Feedback event`

Models propose. Deterministic rules validate time and hard constraints. Persistence follows explicit rules and user confirmation.

## 7. Explicit exclusions

The current product is not a general task manager, complete planner, autonomous life manager, medical/therapeutic ADHD product, broad message-ingestion system, sensitive relationship/mental-state inference system, comprehensive life memory, or replacement for ChatGPT, Calendar, Todoist, or Notion.

## 8. Metrics

| Evidence | Threshold |
|---|---:|
| Recurring weekly problem with concrete cost | ≥70% of 30–40 behavioral interviews |
| Failure: recurring pain | <40% |
| Activation | ≥25% |
| Repeated recommendation acceptance | ≥35% |
| Repeated recommendation completion | ≥25% |
| Week-4 retention | ≥30% |
| Week-8 retention | ≥20% |
| Calendar opt-in among active users | target ≥50% |
| Calendar opt-in failure | <30% |
| Strong pricing intent near $7.99/month | ≥2% of qualified visitors |
| Personalized improvement over simple baseline | ≥20% |

Always report denominators, cohort segments, uncertainty, duration, and comparison against ChatGPT+Calendar, ChatGPT+Todoist, and the user's existing workflow.

## 9. Kill criteria

Gate #61 may return KILL when the product fails to outperform existing workflows, retention is weak, trust is unacceptable, or users show no meaningful willingness to pay. Invasive/judgmental feedback from ≥25% is a major failure signal. Trust/privacy objections above 30% require HOLD. Interview enthusiasm and engineering completion are not demand evidence.

## 10. Data-sharing ladder

1. Manual input.
2. Optional calendar after initial value.
3. In-app behavioral history.
4. User-selected message capture.
5. Sensitive context only if separately justified later.

Each step requires progressive disclosure, scoped consent, visible value, revocation, and deletion. Default private-message ingestion is prohibited.

## 11. Module unlock matrix

| Module | Issues | Market gate | Module evidence |
|---|---|---|---|
| Life-State & Memory | #9–#12 | Required | Retention, missing-context need, calendar/history opt-in, trust, controls |
| Feedback aggregation | #13–#16 | Required | Enough real events; append-only/reversible; inspect/undo |
| Priority | #17–#24 | Required | Multi-commitment competition; baseline insufficiency; behavioral lift |
| Decomposition | #25–#28 | Required | Size/ambiguity evidence and completion lift |
| Planning | #29–#32 | Required | Demand beyond one step, lift, calendar/trust |
| Advanced Recommendations | #33–#36 | Required | Repeated wedge value and material baseline lift |
| Coaching | #37–#40 | Required | Helpful/non-judgmental, disable control, behavioral lift |
| Personalization | #41–#44 | Required | ≥20% baseline lift, inspect/revoke, no private-memory training |
| Shadow Release | #45–#48 | Required | All included modules pass; immutable shadow; operations visible |

A global GO does not unlock all modules. Gate #61 names each allowed module and scope.

## 12. Positioning language

**Headline**

> Turn overwhelm into one clear next step.

**Supporting statement**

> MaybeSitter captures what you committed to, proposes one realistic next action, explains why, and keeps you in control.

## 13. Claims that must not be used

- “Manages your entire life.”
- “Knows you better than you know yourself.”
- “Treats ADHD.”
- “Replaces your judgment.”
- “Automatically understands every private conversation.”
- Any medical, therapeutic, autonomous, or comprehensive-memory promise not supported by validated behavior and consent.

## 14. Current roadmap stage

Approved sequence: Foundations (#1–#4), Capture Quality (#5–#8), V02 (#50–#53), V03 (#54–#57), and V04 (#58–#61). Issues #9–#48 are preserved as a conditional North Star and remain locked.

## 15. Product issue readiness rule

> A product issue without a measurable hypothesis, success threshold, failure threshold, and privacy impact is not ready for implementation.

Use the [Product Experiment issue template](../../.github/ISSUE_TEMPLATE/product-experiment.md). Decisions are GO, CONDITIONAL GO, PIVOT, HOLD, or KILL; every decision cites behavior, trust, commercial evidence, baseline, limitations, and rollback.
