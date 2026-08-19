/**
 * The public surface of the planning constraint model (Sprint 07, issue #29).
 *
 * Two things, and the line between them is the sprint's central rule. The
 * *normalizer* is arithmetic — a wall-clock window materialised against real
 * dates — and the design lets #30's scheduler and #31's oracle import it,
 * because a second copy of that conversion is the Sprint 06 gap rather than a
 * Sprint 06 check. The *validator* is a judgement, and neither may import it:
 * #31's oracle derives the same static verdict independently, and the
 * merge-owned cross-track test compares the two. An import would make that
 * comparison compare a thing with itself.
 *
 * ## What "end times are exclusive" means here
 *
 * Every interval this module produces or consumes is half-open,
 * `[startsAt, endsAt)`, per rule 1 of `planningContracts`. Three consequences
 * are load-bearing and each is pinned by a test:
 *
 *  - A working window's `endMinute` is exclusive, so `09:00-17:00` is
 *    `{ startMinute: 540, endMinute: 1020 }` and does not include 17:00. The
 *    domain runs to 1440 so that "until midnight" is one window rather than a
 *    window plus a special case.
 *  - A fixed event abutting a working window removes nothing from it, and two
 *    back-to-back blocking events are not a `FIXED_EVENT_CONFLICT`. Every
 *    comparison goes through the shared `intervalsOverlap`, so this means the
 *    same thing here as in #30 and #31.
 *  - A deadline lying exactly on the horizon's `endsAt` is *inside* the
 *    horizon, and an occurrence starting exactly at `endsAt` is outside it.
 *
 * ## What "unknown duration is handled explicitly" means here
 *
 * `Effort` is a variant, and the validator destructures it. An `unknown` effort
 * produces `EFFORT_UNKNOWN` and suppresses `EFFORT_EXCEEDS_ITEM_WINDOW`, which
 * has no size to compare against. Nothing in this module estimates, defaults, or
 * substitutes a duration: a plan built on a guessed duration looks feasible and
 * is not, and nothing downstream can tell the difference.
 *
 * ## Two rulings this module follows, decided at integration
 *
 * **`DEADLINE_BEYOND_HORIZON` means "before the plan begins", and only that.**
 * It is emitted when `deadlineAt` is at or before `horizon.startsAt` — the item
 * cannot be finished within this plan's reach, which is an ordinary daily input
 * rather than an edge case, since a stale or missed commitment has exactly that
 * shape. A deadline falling *after* `horizon.endsAt` is not reported at all: the
 * horizon is the binding constraint there and the item is the least constrained
 * thing in the request, so reporting it would be a manufactured failure. This
 * module originally reported the opposite half, which put it in *disjoint*
 * disagreement with #31's oracle on the same input — the worst shape a
 * disagreement can take, because neither side looks partially right.
 *
 * **A judgement is suppressed only when it borrows a bound from something
 * already reported invalid.** Nothing wider. The loose form — "one defect earns
 * one code" — reads as "one item earns one code" on a bad day, and that is how
 * this module briefly hid two real findings. `validator.ts` lists the four
 * suppressions the principle licenses here and nothing else claims one.
 *
 * **A DST anomaly is reported only when it lands inside the plan.**
 * `NONEXISTENT_LOCAL_TIME` and `AMBIGUOUS_LOCAL_TIME` are emitted for an
 * occurrence whose *nominal* extent — where the window would have sat had the
 * offset not moved that day — meets the horizon. An anomalous occurrence the
 * horizon never reaches is silence: sending a user to fix a window with no
 * bearing on anything being planned is noise, not information. The judgement is
 * made in `normalizeWorkingWindows`, the only place that sees the horizon and
 * the nominal extent together, so every consumer inherits one answer rather than
 * deciding separately. The nominal extent is also what distinguishes an
 * occurrence the horizon clipped away (silence) from one a gap swallowed inside
 * the horizon (reported) — neither leaves a materialised window behind, so
 * "did anything survive?" cannot tell them apart.
 *
 * ## Where this module reads more into a code than the contract states
 *
 * Two places, both recorded here because a reading that lives only in an
 * implementation is a reading #31's oracle has to guess at — and the sprint
 * design is explicit that two self-consistent readings of a shared vocabulary
 * leave both suites green and the disagreement invisible.
 *
 * **`INVALID_INTERVAL` covers four window defects that are not interval
 * defects.** The contract defines it as "an interval with `endsAt <= startsAt`,
 * or a working window with `endMinute <= startMinute`". These are also routed to
 * it, for want of any better code in the frozen taxonomy:
 *
 *   1. `weekday` is not an integer in 0..6
 *   2. `startMinute` is not a whole number in 0..1440
 *   3. `endMinute` is not a whole number in 0..1440
 *   4. `timezone` is not a zone this runtime knows
 *
 * Cases 2 and 3 are not redundant with the stated rule and cannot be folded into
 * it: `NaN <= 540` is false and `1441 <= 540` is false, so a malformed minute
 * passes the `endMinute <= startMinute` test and would otherwise reach
 * `resolveLocalTime` and materialise garbage. Case 4 must not fall back to UTC —
 * that would place a Kolkata user's morning five and a half hours from where
 * they said it was, with nothing downstream able to tell.
 *
 * **`EFFORT_NOT_POSITIVE` covers a malformed buffer, not only a malformed
 * effort.** The contract defines it as "a `known` effort of zero or less". A
 * `bufferBeforeMinutes` or `bufferAfterMinutes` that is negative or non-finite is
 * reported under the same code, because it is the same defect — a duration field
 * on this item is not a usable number of minutes, so the total time the item
 * requires cannot be computed. Leaving it unreported is strictly worse than
 * reading the code slightly wide: `required` goes `NaN`, `required > available`
 * is false, and the item is reported *feasible*. #30 then places nothing and
 * reports `NO_FEASIBLE_SLOT` contention for what was a contradiction in the
 * input, with no test on either side seeing a problem.
 *
 * ## Migration and rollback
 *
 * **Migration: none required.** This module is additive and pure. It adds
 * source files under `lib/planning/constraints/` and tests under
 * `tests/planning/`, all of which `package.json` already registered on the
 * sprint base. It defines no schema, writes no row, reads no file, opens no
 * route, and changes no existing module's behaviour — nothing imports it yet
 * except its own tests. There is no data to backfill because there is no data:
 * `PLANNING_PERSISTENCE_POLICY.planCanPersist` is false, and this module is
 * upstream even of a plan.
 *
 * **Rollback: delete the files, or revert the commit.** Because nothing
 * persists and nothing else imports it, reverting leaves no orphaned state, no
 * half-migrated rows and no version skew — the condition that usually makes a
 * rollback harder than the change. The one coupling to check on a revert is the
 * *forward* direction: #30 and #31 are permitted to import `normalizeWorkingWindows`
 * and `freeRunsWithin`, so a revert that lands after either of those tracks must
 * revert them too, or their imports dangle. `tests/planning/constraintsBoundaries.test.ts`
 * pins the reverse direction — this module imports neither sibling — so the
 * dependency can only ever run one way and a revert only ever has one direction
 * to look in.
 *
 * **Forward compatibility.** The exported shapes are additive over the frozen
 * contract, not a second copy of it: `MaterializedWindow` and `WindowAnomaly`
 * describe intermediate results, and every code this module emits comes from
 * `STATIC_INFEASIBILITY_CODES`. A future code added to the contract fails
 * `constraintsValidator.test.ts`'s coverage sweep rather than silently going
 * unreported by one of the two tracks that must agree on it.
 */

export {
  freeRunsWithin,
  mergeIntervals,
  normalizeWorkingWindows,
  type BoundaryResolutionKind,
  type MaterializedWindow,
  type NormalizedWindows,
  type WindowAnomaly,
} from './normalize';

export {
  validateConstraints,
  type ConstraintValidationOptions,
} from './validator';
