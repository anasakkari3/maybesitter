/**
 * The Sprint 07 planning scenarios, feasibility oracle and plan metrics
 * (issue #31).
 *
 * Three modules, in the order a caller uses them:
 *
 *  - `oracle`    — decide, from the constraints alone, which static
 *                  infeasibility codes apply, and how much working time exists
 *                  against how much work was asked for.
 *  - `scenarios` — the curated corpus and its seeded generator, assembled
 *                  through a gate that refuses a corpus missing a kind, holding
 *                  a duplicate id, or asserting an outcome the oracle does not
 *                  produce.
 *  - `metrics`   — placement, churn, unscheduled reasons and utilization over a
 *                  `Plan` supplied as data.
 *
 * **This package deliberately imports neither `lib/planning/constraints/` nor
 * `lib/planning/scheduler/`.** The oracle is the second, independent reading of
 * feasibility that the merge-owned cross-track test compares against #29's
 * validator; an import would make that comparison compare a thing with itself,
 * which is the trap Sprint 06 documented and this sprint's design was written
 * to avoid. Metrics take a `Plan` as data for the same reason: a metrics suite
 * that had to run a scheduler to obtain a fixture would be measuring the
 * scheduler.
 *
 * Shared time arithmetic *is* imported, from `lib/planning/shared/time.ts`.
 * That is the other half of the same rule: two independent implementations of a
 * judgement check each other, two independent copies of arithmetic are a gap.
 *
 * **Every scenario shipped here is synthetic.** No planning scenario has been
 * reviewed by a person, the corpus records that in its `provenance` field, and
 * no score computed from these rows is evidence about anything but the code
 * that produced it. See `docs/data/planning-scenario-corpus.md`.
 */
export * from './oracle';
export * from './scenarios';
export * from './metrics';
